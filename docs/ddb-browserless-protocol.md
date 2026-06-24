# D&D Beyond browserless protocol

Reverse-engineered auth + endpoints that let the DDB bridge run **without a headless browser**,
mirroring the Roll20 RTDB transport ([roll20-realtime-protocol.md](roll20-realtime-protocol.md)).
The browser is touched **once** (cold start) to harvest the long-lived `CobaltSession` cookie; every
read after that is plain Node `fetch`. Implemented in [`src/bridge/ddb-rt.ts`](../src/bridge/ddb-rt.ts);
[`src/bridge/dndbeyond.ts`](../src/bridge/dndbeyond.ts) routes through it; only the character-sheet
read (`getCharacter`) falls back to the browser intercept, and only on a 403 — monster/campaign
reads do not fall back.

## Auth chain

```
CobaltSession cookie  ──POST auth-service/v1/cobalt-token (Cookie header)──▶  JWT (ttl 300s)
JWT  ──Authorization: Bearer──▶  character-service / monster-service reads
JWT + CobaltSession cookie (both)  ──▶  www.dndbeyond.com campaign APIs
```

- `POST https://auth-service.dndbeyond.com/v1/cobalt-token`, header `Cookie: CobaltSession=<value>`,
  body `{}` → `{ token: <JWT>, ttl: 300 }`. The JWT is a 3-segment token, audience `dndbeyond.com`.
  **TTL is only 300s** — cache it in memory with a ~30s margin and re-exchange from the cobalt cookie.
- The `CobaltSession` cookie is the long-lived "remember me" session. Harvested once from the
  persistent browser profile, cached to `data/ddb-cobalt.json`, re-harvested only on a 401/403 during
  exchange. Set `DDB_COBALT` in the env to skip the browser entirely (fully browserless cold start).

## Reads (all validated live, browserless)

| Read | Endpoint | Auth | Notes |
|------|----------|------|-------|
| Character sheet | `GET character-service.../character/v5/character/{id}` | Bearer | **Identical shape** to the browser path — `parseStats`/`getMaxHp` work unchanged. Shared sheets even read with no auth. |
| Monster by id | `GET monster-service.../v1/Monster?ids={id}` | Bearer | Raw monster-service shape — **normalized** to `DdbMonster` by `mapRawMonster` (see mapping below). |
| Monster by name | `GET monster-service.../v1/Monster?search={name}&skip=0&take=10` | Bearer | Returns ranked array; `rtGetMonster` prefers an exact (case-insensitive) name match. |
| Campaign characters | `GET www.dndbeyond.com/api/campaign/stt/active-short-characters/{campaignId}` | Bearer **+** cookie | `{data:[{id,name,avatarUrl,userId,userName}]}`. Replaces the DOM scrape. Cookie **alone** returns the SPA login HTML — both headers required. |
| All campaigns (the "set") | `GET www.dndbeyond.com/api/campaign/stt/active-campaigns` | Bearer **+** cookie | `{status:"success",data:[{id,name,dmUsername,playerCount,dmId,…}]}`. Same endpoint Avrae uses. Replaces the `my-campaigns` DOM scrape. Names are HTML-escaped → decode. |

### Dead endpoints
- `www.dndbeyond.com/api/v5/monster?name=…` (what the old code used) now **404s**. As of 2026-06-20
  `dndbeyond.ts:getMonster` routes through `rtGetMonster` (monster-service) when RT is enabled; the
  dead `www/api/v5` endpoint only remains on the non-RT branch. The routing is wired and the field
  **normalization below is implemented** (`mapRawMonster`, see next section).

### Avrae cross-check (github.com/avrae/avrae)
- Confirms `character-service.../character/v5` (`utils/config.py`) and `…/api/campaign/stt/active-campaigns`
  (`ddb/waterdeep.py`) — same endpoints/shapes.
- **Avrae is an official DDB integration partner**, so it does NOT do the client-side cobalt-token
  exchange — it *mints* its own JWTs signed with a shared `WATERDEEP_SECRET` (`ddb/auth.py`) and
  ingests live events via the partner **Game Log** (DDB → Avrae web tier → internal Redis pubsub,
  `ddb/gamelog/`). The Game Log is push-based and partner-gated — **not** reachable with just a cobalt
  cookie. So our cobalt→JWT exchange is the correct *client* path; a live HP/dice stream would require
  either polling character-service or partner Game Log access (the route Roll20's own official DDB
  integration uses).

### monster-service v1 → `DdbMonster` mapping  ✅ IMPLEMENTED (2026-06-20)
The monster-service ships ids, not friendly values. `getMonster` (RT path) normalizes the raw record
into `DdbMonster` via **`mapRawMonster`** in `dndbeyond.ts`. The id→name lookup tables live in
**`src/bridge/ddb-monster-tables.ts`**, captured verbatim from DDB's `GET www.dndbeyond.com/api/config/json`
(stable 5e ruleset data; validated against the live Horned Devil id 16927). The mapping:
- `challengeRatingId` → CR string via the baked `CR_VALUES` table (fractions render `"1/8"` etc.).
  (The "id − 4" shortcut approximates it but the real table has gaps, e.g. id 28 is skipped — so it's baked.)
- `stats[].statId` → `{id, value}` (1–6 = STR…CHA) so `getMonsterAbilityScores` is unchanged.
- `movements[].movementId` → `DdbMonsterSpeed` (`1 walk, 2 burrow, 3 climb, 4 fly, 5 swim`).
- `alignmentId`/`sizeId` → strings via the `ALIGNMENTS`/`SIZES` tables.
- `conditionImmunities` (id array) → names via the `CONDITIONS` table.
- `damageAdjustments` (id array) → resist/immune/vulnerable name lists, split by the entry's `type`
  (1/2/3). This is the one table that **drifts** as DDB adds content, so it's overlaid from a lazy
  7-day disk cache of `config/json` (`rtGetDamageAdjustments` in `ddb-rt.ts`, gated behind `peekCobalt`
  so it never triggers a browser harvest), with the baked `DAMAGE_ADJUSTMENTS` table as fallback.
- Ability sections are **HTML blobs** (`actionsDescription`, `specialTraitsDescription`, …) →
  parsed by `parseAbilityBlock` into the typed `DdbMonsterAbility[]` arrays (`specialTraits`,
  `actions`, `reactions`, `legendaryActions`, `bonusActions`), with numeric HTML entities (`&#160;`)
  decoded. `getMonsterAbilities` renders these.

Known data-quality note: a few DDB monster records (homebrew with unfilled fields) return
`averageHitPoints: 0` / `armorClass: 0`; the mapper passes them through faithfully — guard against
0 before writing to a token.

## Writes — investigation (NOT wired as tools)

The "can this replace the brittle Beyond20 plugin?" question. Probed **non-destructively** (OPTIONS +
empty/invalid-body PUTs that the server rejects with a field-listing 400 before any mutation). Verdict:
**browserless writes are viable — the JWT bearer authenticates against the mutation endpoints.**

| Target | Endpoint | Methods | Body | Status |
|--------|----------|---------|------|--------|
| Conditions | `character-service.../character/v5/condition` | **PUT** (set), **DELETE** (remove) | `{ characterId, id }` | ✅ confirmed (400 names both fields; auth accepted) |
| Death saves | `character-service.../character/v5/life/death-saves` | **PUT** | `{ characterId, failCount, successCount, … }` | ✅ confirmed live (400 names fields) |
| Whole character | `character-service.../character/v5/character/{id}` | GET only now | — | ❌ old repo `PATCH` is dead (405, allow=GET) |
| **HP** | `life/hp`, `hit-points`, `damage`, … all **404** | PUT (pattern) | unknown | ⚠️ endpoint name not found by blind probing |

Remaining unknown: the **HP** write endpoint name. The reliable next step is to capture one real HP
XHR from a live sheet (load a character in the browser, intercept the `character-service` PUT/POST
fired when HP changes) rather than guessing. `ddb-rt.ts` exposes `rtRawFetch()` as the building block.

Writes are deliberately **not** exposed as MCP tools, and the prior DDB-write tools were **removed**
(this is a finalized decision, not a deferral): DDB is read-only here. Writing conflicts with the
design (Beyond20 owns PC HP and would overwrite a push), and any live mutation of a player's sheet
should be a deliberate, consented action — see the read-only rationale in `src/tools/ddb.ts` and
`docs/decisions.md` §1. The probe results above are kept only to record that the path is technically
viable should that decision ever be revisited.

## Config
- Default transport is browserless (`rt`). Force the old Playwright path with `DDB_TRANSPORT=browser`.
- `DDB_COBALT=<cookie>` — supply the cobalt session directly; cold start never touches the browser.

## Recon scripts (`src/recon/`)
`ddb-browserless.ts` (auth + read sweep), `ddb-charsvc-diag.ts` (the transient "fetch failed" on
character-service — clears on a single retry), `ddb-monster-diag.ts` (monster endpoint discovery),
`ddb-write-probe.ts` / `ddb-hp-endpoint.ts` (non-destructive write probes), `ddb-smoke.ts` (end-to-end
bridge test). Dumps with live tokens go to gitignored `.tmp-test-data/`.
