# CLAUDE.md — roll20-dm-mcp

Orientation for an agent doing development in this repo. Read this first; it points to the
canonical deep-dive docs rather than duplicating them. Two domains have their own sections
below: **Maps development** and **Combat development**.

## What this is

AI-assisted D&D 5e session management for **Roll20 + D&D Beyond**. Three components:

- **`roll20-dm`** — live-combat MCP server over **HTTP** (`src/index-http.ts` → `src/server-combat.ts`).
  HP, conditions, initiative, dice, narration, turn hooks, AoE, tactics, DDB reads. Also keeps the two
  **dual-use** map tools it needs live: **zones** (fixed-area spells) and **screenshot** (board vision).
- **`roll20-dm-maps`** — map-prep MCP server over **stdio** (`src/index-maps.ts`). Owns the full
  **map/wall/zone domain**: battlemap upload, Claude-Vision wall detection, DL walls/doors, token
  creation, zones, screenshots. The prep-only analysis/wall tools (`registerVisionTools`) live here only;
  zones (`zones.ts`) + screenshot (`screenshot.ts`) are **shared modules** registered in both servers.
- **Voice HUD** (`voice-hud/`) — Electron overlay (PTT → Whisper STT → Claude agent). Reads the
  root `.env` and the canonical rules in `skills/dm-rules.md` at runtime.

There is also a stdio combat server entry (`src/index-combat.ts`, `npm start` → `dist/index-combat.js`).

## Build / run / test / deploy

- **Node 20+** (TypeScript 6 build needs it). `npm install` then `npx playwright install chromium`.
- `npm run serve` — runs the HTTP server via `tsx` (no build step needed for dev). First run
  generates `ROLL20_MCP_TOKEN`, writes it to `.env`, and injects it into `.mcp.json`.
- `npm run build` — `tsc` → `dist/`. **Required** for the stdio servers referenced in `.mcp.json`
  (`dist/index-maps.js`) and `npm start`. Not required for `npm run serve`.
- `npm test` — vitest (`src/**/*.test.ts` + `test/*.test.ts`). `npm run test:watch` to iterate.
- **Mod redeploy (manual, easy to forget):** the relay (`mod-scripts/ai-relay.js`) runs inside the
  Roll20 API sandbox; a change to it only takes effect once deployed. **One command does it:
  `npm run release:mod`** (`src/recon/release-mod.ts`) — deploys to the *active* campaign via browser
  automation (background page; doesn't disturb a live session), then runs the soak and exits non-zero
  if either fails. (Equivalent to `deploy_mod_script` + `tsx src/recon/soak-test.ts` by hand, or the
  old fully-manual paste-into-the-API-console.) CI runs `node --check mod-scripts/ai-relay.js` as a
  syntax gate but cannot deploy.
- `src/recon/*` are manual live scripts (real campaign), run with `tsx` — the smoke/soak layer.
  They are excluded from the prod build.

## Architecture & transport (how a tool reaches Roll20)

`Claude → MCP tool (TS) → roll20.relayCommand({action,…}) → ai-relay.js (Mod sandbox) → Roll20 objects`

- **RT is the DEFAULT and combat is browserless** (`ROLL20_TRANSPORT` defaults to `rt`; set
  `=browser` to opt OUT to the legacy relay, dev only). `relayCommand` pushes `!ai-relay {JSON}`
  over the campaign's Firebase RTDB and reads `AIBRIDGE_RESULT` back over an RTDB child listener
  (~50ms). It carries **reads AND writes** — the Mod executes every action regardless of transport.
  Some reads are served even more directly (`rtGet`/`tryDirectRead` off RTDB; `CLIENT_READS` in
  `roll20.ts` off live Backbone, but only on the explicit `=browser` path).
- **No silent browser fallback on the combat relay.** A packaged install ships no Playwright, so an
  RT failure SURFACES (clear error → re-harvest the token in the gem) rather than quietly reaching
  for a Chromium that isn't there. The browser→chat relay (types into chat, reads `/w gm` via
  MutationObserver) runs ONLY under `ROLL20_TRANSPORT=browser`. Token harvest itself is first-party
  session capture in the gem's own Electron browser (intercept Roll20's `signInWithCustomToken` /
  read DDB's `CobaltSession` cookie) — NOT OAuth, no registered client. (See issue #83.)
- **D&D Beyond is READ-ONLY and browserless** (`DDB_TRANSPORT` defaults to `rt`): `CobaltSession`
  cookie → short-lived JWT → `character-service`/`monster-service`. No DDB writes exist; all the
  write tools were removed.

Deep dives: `docs/decisions.md`, `docs/roll20-api-coverage.md`, `docs/roll20-realtime-protocol.md`,
`docs/ddb-browserless-protocol.md`, `docs/choreography.md`, `docs/security.md`, `docs/build-and-test-plan.md`.

## Project-wide gotchas (these have bitten us — heed them)

- **Never write `undefined`/`NaN` to a token.** `t.set()` with an undefined/NaN value
  async-crashes the *entire* Mod sandbox (looks like a timeout/congestion). **Every object-form
  write goes through the `setSafe(obj, props)` chokepoint** (`obj.set(stripUndef(props))`) — use it
  for any new object write; never call `.set({…})` directly. Key/value string writes (`statusmarkers`,
  `turnorder` JSON, `name`) are type-safe by construction. A regression test
  (`test/relay-actions-smoke.test.ts` → "setSafe write guard") proves bad values are dropped, not
  written. (`docs` + memory: relay-undefined-firebase-crash.)
- **Roll20 object quirks:** read type as `_type` (not `type`); turn-order entries need `_pageid`;
  `createObj("page")` is **unsupported** in the sandbox — pages are made by `createPageViaUI`
  (Playwright). Walls use `pathv2` (re-anchors to the first point regardless of passed x/y — pass
  first-point-as-center).
- **The Mod sandbox cannot import TS.** Tables that must agree are kept in **hand-synced copies** —
  most importantly the condition→marker map lives in three places (`src/tools/combat.ts` array,
  `src/bridge/markers.ts` Record, `mod-scripts/ai-relay.js`) and they are **not identical**
  (`wounded`/`bloodied` is a condition in `combat.ts` but a pseudo-marker in the other two). Edit
  all relevant copies together.
- **MCP tool inputs are Zod-validated**; relay actions are a hardcoded `switch` in `ai-relay.js`
  (no eval/shell). GM-only sender check (`senderIsGM`) is the authorization boundary — chat is
  player-writable.
- Registry files (`data/campaigns.json`, `characters.json`, `active-campaign.json`) are written
  atomically (temp-then-rename). `data/` is gitignored and holds live credentials — never commit it.

## Where things live

```
src/index-http.ts        roll20-dm HTTP server bootstrap (auth, /mcp, /events SSE)
src/server-combat.ts     registers the roll20-dm toolset
src/index-maps.ts        roll20-dm-maps stdio server (registers the map toolset)
src/tools/               MCP tools (one register*Tools fn per file)
src/bridge/              roll20.ts (relay+fallback), roll20-rt.ts (RT), dndbeyond.ts, ddb-rt.ts,
                         markers.ts, relayState.ts, browser.ts, transport-health.ts
src/registry/            campaigns + character registries (JSON-backed)
mod-scripts/ai-relay.js  the Roll20 Mod sandbox relay (deploy manually)
skills/                  dm-rules.md (canonical play rules), dm-map-setup.md
.claude/commands/        /combat, /round (session choreography)
docs/                    architecture, decisions, protocols, coverage, security
test/                    integration tests + the Roll20 emulator (roll20-emulator.ts, harness.ts)
```

Adding a tool: write `register*Tools(server)` with a Zod schema in the right `src/tools/*.ts`, wire
any new relay action into `mod-scripts/ai-relay.js`'s `switch` (then redeploy the Mod), and register
the tool in the correct server — **`server-combat.ts`** (roll20-dm) or **`index-maps.ts`**
(roll20-dm-maps). Add a unit test (pure logic) and/or a `test/` emulator test.

---

## Maps development

**Server:** `roll20-dm-maps` (stdio, `src/index-maps.ts`). **Code:** `src/tools/maps.ts`,
`src/tools/vision.ts`, `src/tools/tokens.ts`, `src/tools/batch.ts`, `src/tools/zones.ts`,
`src/tools/screenshot.ts`. **Skill:** `skills/dm-map-setup.md`. (`zones.ts` + `screenshot.ts` are shared
with the combat server — register them in **both** `index-maps.ts` and `server-combat.ts` if you touch
the registration; the rest of vision/wall tooling is maps-only.)

**Pipeline** (image → playable lit map):
1. `analyze_battlemap({imagePath})` — `src/tools/vision.ts` calls the Anthropic API
   (`VISION_MODEL = claude-sonnet-4-6`) to return grid size/offset, wall centerlines, doors,
   windows, secret doors, plus `estimatedTokens`/`imageDimensions`. There's a two-pass Hough
   refinement option.
2. `setup_roll20_page(...)` — creates the page via **`createPageViaUI`** (Playwright; `createObj("page")`
   is unsupported) then `setPageProps` to size it.
3. `auto_place_dl_walls({walls, strokeColor})` — places DL `pathv2` walls.
4. `decorate_openings({doors, windows, secretDoors})` — creates **native Roll20 DL door/window
   objects** (not map-layer rectangles): doors `#FF0000`, windows `#00FFFF`, secret doors `#9932CC`.

**Map gotchas:**
- **Wall color:** `auto_place_dl_walls` and `place_polyline_walls` default `strokeColor` to yellow
  `#FFFF00`. **Always pass `#0044FF`** (project convention: blue walls, green windows) — the default
  violates it.
- `pathv2` re-anchors to the first point regardless of passed x/y — build paths first-point-as-center.
- **Upload dedup:** `upload_and_place` reuses a stale art-library asset by filename — use a unique
  filename. `create_monster_token` 404s without a DDB compendium entry → fall back to
  `create_npc_token`.
- `batch_import_maps` is the folder→Roll20 pipeline (uses `listPages` + the steps above).

## Combat development

**Server:** `roll20-dm` (HTTP, `src/server-combat.ts`). **Code:** `src/tools/combat.ts`,
`src/tools/tactics.ts`, `src/tools/aoe.ts`, `src/tools/combatHelpers.ts`, `src/bridge/relayState.ts`.
**Canonical play rules:** `skills/dm-rules.md`. **Choreography:** `.claude/commands/{combat,round}.md`.

**HP model (important):** routing is by `controlledby` (`isPcToken` in `src/tools/aoe.ts`):
- **PC** (player-controlled) → HP tracked in relay **state**, a block in the token's `gmnotes`, via
  the `adjustPcHp` relay action. **Never write a PC's token bar** — Beyond20 owns it. Reported as
  `(tracked)`.
- **NPC** → HP is `bar1` on the token.
- `update_token_hp` (single) and `update_hp_many` (AoE) and `resolve_aoe` all follow this split.
  `resolve_aoe` is the one-call AoE primitive (find targets, roll/read saves, apply).

**Conditions/markers:** `set_token_marker` → `toggleCondition` → three-tier `resolveMarkerForState`
(CONDITION → PSEUDO → hashed ad-hoc). Custom campaign marker set, IDs 4444311–4444352; default
Roll20 icons render nothing on these tokens. See `docs/roll20-token-markers.md`. (Remember the three
hand-synced table copies.)

**Initiative / turn order (safety-critical):**
- **Never `setTurnOrder` wholesale** — a raw full write replaces the entire order, erasing
  players. The initiative paths avoid it: `roll_initiative` writes via atomic `mergeTurnOrder`, and
  `clearFirst=true` strips **only** NPC entries (`clearNpcFirst`) — player entries and round markers
  are always kept, so players' inits survive any roll (clearFirst true or false). Add NPCs with
  `roll_initiative npcOnly=true`; adjust one entry with `update_turn_order`; insert round markers with
  `inject_round_marker` (needs `formula:"+1"`). The only wholesale wipe is `clear_turn_order`
  (between encounters); `setTurnOrder` is also reachable via `batch_exec` — don't pass it wholesale.
- **PC initiative is read-only** — players roll their own.
- `roll_initiative` always arms the turn hook itself. `clearFirst=true` is the only thing that
  auto-fires tactics (`fireTacticsForPage`); with `clearFirst=false` call `plan_all_tactics`
  explicitly.
- **Never auto-advance the turn** — `advance_turn` only on the DM's explicit say-so.

**Tactics:** `plan_tactics`/`plan_all_tactics` scale by creature Int/Wis to a tier (`TIER_CONFIGS`
in `tactics.ts`); tiers 4–5 are multi-model cascades (Haiku→Sonnet→Opus). Dice always roll through
Roll20's public roller (`roll_dice`), never a TS RNG.

**Narration convention (the assistant reports; the DM narrates):** emit a markdown report every turn;
never put numbers (HP/damage/totals) in player-visible `send_narration`; narrate round-end with
effect countdowns; dead tokens → mark dead + move to the map layer; emanations (Spirit Guardians) use
a token **aura**, fixed areas use `create_zone`. Full rules: `skills/dm-rules.md`.

**DDB monster mapper (done, 2026-06-20):** `dndbeyond.getMonster()` routes to `rtGetMonster` and
normalizes the raw monster-service v1 shape (id-arrays like `challengeRatingId`/`movements`/
`damageAdjustments`, plus HTML `*Description` blobs) into `DdbMonster` via `mapRawMonster`. Lookup
tables are baked in `src/bridge/ddb-monster-tables.ts` (captured from DDB's `config/json`); the one
drifting table, `damageAdjustments`, is overlaid from a lazy 7-day disk cache (`rtGetDamageAdjustments`,
gated so it never harvests a browser). `ddb_get_monster` now returns a real `challengeRating`. See
`docs/ddb-browserless-protocol.md`.
