# CLAUDE.md — roll20-dm-mcp

Orientation for an agent doing development in this repo. Read this first; it points to the
canonical deep-dive docs rather than duplicating them. Two domains have their own sections
below: **Maps development** and **Combat development**.

## What this is

AI-assisted D&D 5e session management for **Roll20**. Three components:

- **`roll20-dm`** — live-combat MCP server over **HTTP** (`src/index-http.ts` → `src/server-combat.ts`).
  HP, conditions, initiative, dice, narration, turn hooks, AoE, mob-plan storage. Roll20 ONLY — no
  D&D Beyond, no LLM, no browser (#171, #179). Also keeps the dual-use **zones** tools it needs live
  (fixed-area spells). `screenshot_roll20` is GONE — a screenshot needs a renderer.
- **`roll20-dm-maps`** — map-prep MCP server over **stdio** (`src/index-maps.ts`). Owns the full
  **map/wall/zone domain**: battlemap upload, Claude-Vision wall detection, DL walls/doors, token
  creation, zones, screenshots. The prep-only analysis/wall tools (`registerVisionTools`) live here only;
  `zones.ts` is a **shared module** registered in both servers.
- **DM Whisper** — the Electron voice gem (PTT → Whisper STT → Claude agent). **No longer in this
  repo.** Split out to https://github.com/eschatus/dm-whisper on 2026-08-11 and closed source; it
  consumes this repository as a pinned dependency and bundles `skills/dm-rules.md`,
  `mod-scripts/ai-relay.js` and the server itself into its installer. Changes to those files reach
  the gem only when it re-pins. This repository stays open under MIT — see LICENSE and NOTICE.

There is also a stdio combat server entry (`src/index-combat.ts`, `npm start` → `dist/index-combat.js`).

## Build / run / test / deploy

- **Node 20+** (TypeScript 6 build needs it). `npm install` — **no browser step**: this repo has no
  Playwright dependency at all (#179).
- `npm run serve` — runs the HTTP server via `tsx` (no build step needed for dev). First run
  generates `ROLL20_MCP_TOKEN`, writes it to `.env`, and injects it into `.mcp.json`.
- `npm run build` — `tsc` → `dist/`. **Required** for the stdio servers referenced in `.mcp.json`
  (`dist/index-maps.js`) and `npm start`. Not required for `npm run serve`.
- `npm test` — vitest (`src/**/*.test.ts` + `test/*.test.ts`). `npm run test:watch` to iterate.
  Single file: `npx vitest run test/zone-semantics.test.ts`; single case: add `-t "name substring"`.
- `npm run lint` — eslint over `src/` + `test/`.
- **Mod redeploy is EXTERNAL to this repo (#175).** The relay (`mod-scripts/ai-relay.js`) runs in
  the Roll20 API sandbox and only takes effect once deployed — but deploying means driving a
  browser against a live account, so it is a human-attended act, not something an MCP server or a
  dev session does. Paste `mod-scripts/ai-relay.js` into the campaign's API console yourself (or
  use the gem's attended flow). Verify the LOAD, never the write: the sandbox banner
  `[GM_AI_Bridge] Relay script loaded (vX.Y.Z)` or a `ping` returning the version. Deploys are
  **per-campaign** — each campaign carries its own copy, so one can run a newer relay than another.
  CI runs `node --check mod-scripts/ai-relay.js` as a syntax gate.
- **Relay version handshake:** `AI_RELAY_VERSION` (`mod-scripts/ai-relay.js`) and
  `EXPECTED_RELAY_VERSION` (`src/bridge/relay-version.ts`) are a hand-synced pair, locked by
  `test/relay-version.test.ts` — bump BOTH when changing `ai-relay.js` in a way worth flagging to a
  DM on a stale deploy. A mismatch warns once (never throws) and surfaces via `transport_status`.
- `src/recon/*` are manual live scripts (real campaign), run with `tsx` — the smoke/soak layer.
  They are excluded from the prod build.

## Architecture & transport (how a tool reaches Roll20)

`Claude → MCP tool (TS) → roll20.relayCommand({action,…}) → ai-relay.js (Mod sandbox) → Roll20 objects`

- **RT is the DEFAULT and combat is browserless** (RT is the ONLY transport — the legacy browser relay is gone (#122/#179)). `relayCommand` pushes `!ai-relay {JSON}`
  over the campaign's Firebase RTDB and reads `AIBRIDGE_RESULT` back over an RTDB child listener
  (~50ms). It carries **reads AND writes** — the Mod executes every action regardless of transport.
  Some reads are served even more directly (`rtGet`/`tryDirectRead` off RTDB; `CLIENT_READS` in
  `roll20.ts` off live Backbone, but only on the explicit `=browser` path).
- **THERE IS NO BROWSER IN THIS REPO (#179).** Not in either server, not in recon, not in
  `package.json`. If a thing needs a browser, it is not an MCP tool here — that rule is why page
  creation was rebuilt over RTDB (#178) and why `screenshot_roll20` left. The browser recon
  instruments live in the sibling `roll20-recon` repo; the wall-dataset harvesters live in
  `wall-seg`. Credentials are FURNISHED, never minted: the RT token is read from
  `<data dir>/roll20-rt-token.json` (campaign-scoped) and art uploads from
  `roll20-upload-cache.json`; both throw a typed error (`Roll20TokenUnavailableError`,
  `Roll20UploadCredentialError`) naming what to refresh instead of harvesting. Art upload is a
  plain multipart POST — browserless, credential furnished. Harvesting happens in the gem's own
  logged-in session, where a human is present. The legacy browser→chat relay is DELETED (#122/#179) —
  RT is the only transport, and an RT failure is a loud hard stop, never a quiet fallback. Harvest
  is first-party session capture in the gem's own Electron browser (intercepting Roll20's
  `signInWithCustomToken`) — NOT OAuth, no registered client. (See #83, #177.)
- **There is no D&D Beyond here any more (#171 Phase 2).** The whole bridge — cobalt→JWT auth,
  character/monster reads, the game-log roll pump — extracted to **beyond-mcp**
  (github.com/eschatus/beyond-mcp), which the gem bundles and treats as its default lookup backend.
  Anything wanting DDB stats resolves them THERE and passes them in (see `roll_initiative`'s
  `entries[]`, and the token tools' caller-supplied stats). This server holds no DDB credential.

Deep dives: `docs/decisions.md`, `docs/roll20-api-coverage.md`, `docs/roll20-realtime-protocol.md`,
`docs/choreography.md`, `docs/security.md`, `docs/build-and-test-plan.md`. (The DDB protocol docs
moved to beyond-mcp with the code.)

## Project-wide gotchas (these have bitten us — heed them)

- **Never write `undefined`/`NaN` to a token.** `t.set()` with an undefined/NaN value
  async-crashes the *entire* Mod sandbox (looks like a timeout/congestion). **Every object-form
  write goes through the `setSafe(obj, props)` chokepoint** (`obj.set(stripUndef(props))`) — use it
  for any new object write; never call `.set({…})` directly. Key/value string writes (`statusmarkers`,
  `turnorder` JSON, `name`) are type-safe by construction. A regression test
  (`test/relay-actions-smoke.test.ts` → "setSafe write guard") proves bad values are dropped, not
  written. (`docs` + memory: relay-undefined-firebase-crash.)
- **Roll20 object quirks:** read type as `_type` (not `type`); turn-order entries need `_pageid`;
  `createObj("page")` is **unsupported in the Mod sandbox** — but that is a MOD limitation, not an
  RTDB one: `rtCreatePage` (`roll20-rt.ts`) creates pages by writing the `pages` node directly,
  proved live in #178. **Its units bite:** page `width`/`height` are **70px units, not cells**
  (rendered cell size is `70 * snapping_increment`), and `zorder`/`thumbnail`/`placement` are
  per-page content that must be RESET, never copied from the template page. The RTDB page carries
  only 16 fields — `scale_number`/`scale_units`/`showgrid` live on the MOD's page object, so
  creation is RTDB then `setPageProps`. Walls use `pathv2` (re-anchors to the first point
  regardless of passed x/y — pass first-point-as-center).
- **Roll20 `path` objects silently drop unsupported properties.** They have no `name`, `gmnotes`,
  or working `fill_opacity` — `createObj`/`set` just discards the write, no error (bit us twice:
  #162, #164). Zone metadata therefore lives in **`state.GM_AI_Bridge.zones`**, not on the path
  object; zone tint is baked into the fill color instead of an opacity prop. Anything keyed off
  path-object metadata is dead by construction — go through the zones state.
- **Two sandboxes now: v1.0 and v1.5, and v1.5 became the DEFAULT on 2026-09-02** for any campaign
  that never explicitly picked one. Per-campaign, like a relay deploy. `ping` echoes
  `Campaign().sandboxVersion`/`nodeVersion`/`sheetName` plus a `beacon` flag (relay ≥ 2.6.0) and
  `transport_status` shows them under `sandbox`. The fork that bites: a **Beacon** ("advanced")
  character sheet keeps data in *computed properties*, not `attribute` objects — `findObjs` can't
  see it and `createObj("attribute")` can't reach it, so an attribute write there is created,
  unread, and looks successful. `setCharacterAttributes` now refuses it and returns a reason;
  `setComputed`/`setSheetItem` are the real carriers and aren't wired yet (#205).
- **Nothing may reach `sendChat` carrying a live chat trigger.** Roll20 live-evaluates `[[`
  (inline roll), `@{` (attribute ref) and `%{` (ability/macro call) in EVERY outgoing message; a
  malformed one throws inside Roll20's own chat pipeline — asynchronously, uncatchable — and
  **disables the whole Mod sandbox**. `writeResult` neutralized these from the start and nothing
  else did, so the `!dm` handler echoed player-typed text straight back: `!dm [[grapple the ogre`
  took the relay down for a live table, as would a player merely *named* `[[grim`. Two helpers now
  own this: **`chatSafe(s)`** entity-encodes the three triggers for anything rendered as text
  (idempotent, safe to layer), and **`chatSafeTarget(name)`** *strips* them from a whisper's
  routing address, where an entity would misroute the whisper AND still fire. `esc()` composes
  `chatSafe` — HTML-escape first, then neutralize, or the `&` in `&#64;` gets double-escaped —
  so every `esc()` call site is covered. `esc()` is NOT idempotent; apply it once. Deliberate
  exceptions, both server-composed and GM-only: `postChat` (must emit real roll-template syntax)
  and the `[[1d20…]]` the initiative builders send — there, escape the *token name*, never the
  whole message. Pinned by `test/chat-trigger-safety.test.ts`.
- **The Mod sandbox cannot import TS.** Tables that must agree are kept in **hand-synced copies** —
  most importantly the condition→marker map lives in three places (`src/tools/combat.ts` array,
  `src/bridge/markers.ts` Record, `mod-scripts/ai-relay.js`) and they are **not identical**
  (`wounded`/`bloodied` is a condition in `combat.ts` but a pseudo-marker in the other two). Edit
  all relevant copies together.
- **MCP tool inputs are Zod-validated**; relay actions are a hardcoded `ACTIONS` map (object
  dispatch) in `ai-relay.js` (no eval/shell). GM-only sender check (`senderIsGM`) is the authorization boundary — chat is
  player-writable.
- Registry files (`data/campaigns.json`, `characters.json`, `active-campaign.json`) are written
  atomically (temp-then-rename). `data/` is gitignored and holds live credentials — never commit it.
- **`repeating_npcaction` rows need `rollbase` to render as a clickable attack.** Writing
  `repeating_npcaction_<row>_name`/`attack_tohit`/`attack_damage` via `setCharacterAttributes`
  creates the data but not a working roll button — the sheet's own sheet-worker JS normally
  generates the companion fields (`attack_tohitrange`, `attack_onhit`, `damage_flag`,
  `attack_crit`/`attack_crit2`, and critically `rollbase`) on real UI events only, never on
  API-created attributes (same root cause as the ability-`_mod` gap below). Fix: write all of
  them yourself. `rollbase` is a **fixed macro template, identical across every attack row on the
  sheet** — copy it verbatim:
  `@{wtype}&{template:npcfullatk} {{attack=1}} @{damage_flag} @{npc_name_flag} {{rname=@{name}}} {{r1=[[@{d20}+(@{attack_tohit}+0)]]}} @{rtype}+(@{attack_tohit}+0)]]}} {{dmg1=[[@{attack_damage}+0]]}} {{dmg1type=@{attack_damagetype}}} {{dmg2=[[@{attack_damage2}+0]]}} {{dmg2type=@{attack_damagetype2}}} {{crit1=[[@{attack_crit}+0]]}} {{crit2=[[@{attack_crit2}+0]]}} {{description=@{show_desc}}} @{charname_output}`.
  Non-attack entries (save effects, passive traits) don't need any of this — just
  `name`/`description`/`npc_options-flag: 0`. Legendary actions live in a parallel
  `repeating_npcaction-l_` section with the same schema. **Never read a field containing literal
  `@{`/`[[` (e.g. `rollbase`) back through `getCharacterAttributes`/`read_character_attributes`**
  — Roll20's chat pipeline live-evaluates it on echo and errors (the writeResult escape fix keeps
  this from crashing the whole sandbox, but the read still fails). Verify writes instead by
  reading `Campaign.characters.get(id).attribs` directly in the browser, which bypasses the
  chat-echo path entirely — see `scripts/dump-character-attrs.ts` and
  `scripts/find-character-by-name.ts`.
- **Ability-score `_mod` attributes don't auto-derive either**, for the same sheet-worker-never-
  fires-on-the-API reason. `createCharacter`'s relay action now derives `<ability>_mod` from the
  raw score at creation time (an explicitly-passed `_mod` is left untouched) — see
  `ACTIONS["createCharacter"]` in `ai-relay.js`.

## Where things live

```
src/index-http.ts        roll20-dm HTTP server bootstrap (auth, /mcp, /events SSE)
src/server-combat.ts     registers the roll20-dm toolset
src/index-maps.ts        roll20-dm-maps stdio server (registers the map toolset)
src/tools/               MCP tools (one register*Tools fn per file)
src/bridge/              roll20.ts (relay+fallback), roll20-rt.ts (RT),
                         markers.ts, relayState.ts, transport-health.ts
src/registry/            campaigns + character registries (JSON-backed)
mod-scripts/ai-relay.js  the Roll20 Mod sandbox relay (deploy manually)
skills/                  dm-rules.md (canonical play rules), dm-map-setup.md
.claude/commands/        /combat, /round (session choreography)
docs/                    architecture, decisions, protocols, coverage, security
test/                    integration tests + the Roll20 emulator (roll20-emulator.ts, harness.ts)
scripts/                 one-off live diagnostics (run with tsx, e.g. dump-character-attrs.ts)
wiki/                    GitHub wiki content (user-facing setup/player docs)
```

**Mothballed/leftover directories — don't develop here:** `training/` moved to dm-whisper
(`training/MOVED.md` is the tombstone); a local untracked `voice-hud/` may linger from before the
2026-08-11 gem split — the real code is in the dm-whisper repo.

Adding a tool: write `register*Tools(server)` with a Zod schema in the right `src/tools/*.ts`, wire
any new relay action into `mod-scripts/ai-relay.js`'s `ACTIONS` map (then redeploy the Mod), and register
the tool in the correct server — **`server-combat.ts`** (roll20-dm) or **`index-maps.ts`**
(roll20-dm-maps). Add a unit test (pure logic) and/or a `test/` emulator test.

---

## Maps development

**Server:** `roll20-dm-maps` (stdio, `src/index-maps.ts`). **Code:** `src/tools/maps.ts`,
`src/tools/vision.ts`, `src/tools/tokens.ts`, `src/tools/batch.ts`, `src/tools/zones.ts`,
**Skill:** `skills/dm-map-setup.md`. (`zones.ts` is shared with the combat server — register it in
**both** `index-maps.ts` and `server-combat.ts` if you touch the registration; the rest of the
vision/wall tooling is maps-only.)

**Pipeline** (image → playable lit map):
1. `analyze_battlemap({imagePath})` — `src/tools/vision.ts` calls the Anthropic API
   (`VISION_MODEL = claude-sonnet-4-6`) to return grid size/offset, wall centerlines, doors,
   windows, secret doors, plus `estimatedTokens`/`imageDimensions`. There's a two-pass Hough
   refinement option.
2. `setup_roll20_page(...)` — creates the page **browserlessly via `rtCreatePage`** (a direct RTDB
   write to the `pages` node, #178 — `createObj("page")` is a MOD-sandbox limitation only), then
   `setPageProps` over the Mod for the fields the RTDB page doesn't carry (scale_number/scale_units/
   showgrid). NB page `width`/`height` are **70px units, not cells**.
3. `auto_place_dl_walls({walls, strokeColor})` — places DL `pathv2` walls.
4. `decorate_openings({doors, windows, secretDoors})` — creates **native Roll20 DL door/window
   objects** (not map-layer rectangles): doors `#FF0000`, windows `#00FFFF`, secret doors `#9932CC`.

**Map gotchas:**
- **Wall color:** `auto_place_dl_walls` and `place_polyline_walls` default `strokeColor` to yellow
  `#FFFF00`. **Always pass `#0044FF`** (project convention: blue walls, cyan windows (#00FFFF)) — the default
  violates it.
- `pathv2` re-anchors to the first point regardless of passed x/y — build paths first-point-as-center.
- **Upload dedup:** `upload_and_place` reuses a stale art-library asset by filename — use a unique
  filename.
- **Token creation takes CALLER-SUPPLIED STATS** (#171): `create_pc_token` / `create_npc_token` /
  `create_monster_token` perform no lookup — resolve HP/AC yourself (ddb-mcp, a module stat block,
  the DM) and pass them. `create_monster_token` is now identical to `create_npc_token` and kept only
  for existing callers; the old "404s without a DDB compendium entry, fall back to `create_npc_token`"
  gotcha is gone with the lookup. **Pass `controlledBy` on `create_pc_token`** — `createToken` has no
  such field, so it's a follow-up write, and without it the token fails `isPcToken` and its HP routes
  to `bar1` like an NPC's. AC is reported back but never stored: `createToken` doesn't set
  `represents`, so a bare token has no sheet to hold it.
- `batch_import_maps` is the folder→Roll20 pipeline (uses `listPages` + the steps above).

## Combat development

**Server:** `roll20-dm` (HTTP, `src/server-combat.ts`). **Code:** `src/tools/combat.ts`,
`src/tools/aoe.ts`, `src/tools/combatHelpers.ts`, `src/bridge/relayState.ts`.
**Canonical play rules:** `skills/dm-rules.md`. **Choreography:** `.claude/commands/{combat,round}.md`.

**HP model (important):** routing is THREE-way (`classifyToken`/`isPcToken`/`splitPcNpc` in
`src/tools/aoe.ts`) — `controlledby` alone only tells player-controlled from not; a per-character
registry override (`sidekick: true`, `src/registry/characters.ts`) is needed to pick out sidekicks:
- **PC** (player-controlled, no sidekick override) → HP tracked in relay **state**, a block in the
  token's `gmnotes`, via the `adjustPcHp` relay action. **Never write a PC's token bar** — Beyond20
  owns it. Reported as `(tracked)`.
- **NPC** (not player-controlled) → HP is `bar1` on the token.
- **Sidekick** (player-controlled, `sidekick: true` in the characters registry — e.g. Tua, Salros
  Eventide, Amri in the Firebirds campaign) → HP is `bar1`, same as an NPC, and it **dies like an
  NPC** (`kill_token`: immediate dead marker + map layer, no PC dying/death-saves state). Set/clear
  the override with `set_token_class` (voice: "Tua is a sidekick").
- `update_token_hp` (single), `update_hp_many` (batch), `resolve_aoe` (AoE), and `roll_initiative`
  (npcOnly / `entries[].hp` seeding) all read the same `sidekickNames` set
  (`registry.listSidekickNames()`) so a sidekick routes as an NPC everywhere HP/death routing is
  decided. See issue #132.

**Auras (emanations):** `set_token_aura` is the one-call primitive — radius in feet, `0` clears,
slot 1 or 2, player-visible by default. Shape goes to `aura{n}_options` (the authoritative field;
Roll20 keeps the legacy `aura{n}_square` boolean in sync with it, so never write both). Roll20
documents `"circle"`/`"square"`; the 2026-09-01 release added hex and outline-only variants whose
property strings Roll20 hasn't published, so the schema takes a free string rather than a guessed
enum. Emanations that move with a creature use an aura; fixed areas use `create_zone`.

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
  (Both `setTurnOrder` paths are now ONE implementation in `runBatchOp`. They used to be two copies
  that had drifted on the argument name — `entries` vs `turnorder` — so a `batch_exec` setTurnOrder
  wrote `[]` and erased every player's initiative while reporting `ok:true`. Never re-fork them;
  `test/relay-actions.test.ts` pins both paths.)
- **PC initiative is read-only** — players roll their own.
- `roll_initiative` always arms the turn hook itself. It no longer fires tactics — the gem plans
  and stores plans through `set_mob_plan` (#171).
- **Never auto-advance the turn** — `advance_turn` only on the DM's explicit say-so.

**Tactics live in the gem now (#171 Phase 2).** This server keeps only the *storage* primitives:
`set_mob_plan` writes a mob's plan (the turn hook whispers it to the DM on that token's turn),
`get_mob_plans` reads them back, and `clear_mob_plans` wipes them all at encounter end — plans
persist in relay state until overwritten or cleared, so a stale one resurfaces as a whisper the next
time that token's turn comes up. There is no model call and no `ANTHROPIC_API_KEY` on the combat
server — `@anthropic-ai/sdk` remains in `package.json` solely for the maps suite's
`analyze_battlemap`. Player `!`-commands are likewise ANSWERED by the gem; this server only
forwards them, as `chat-message` events on the `/events` SSE stream. Dice always roll through
Roll20's public roller (`roll_dice`), never a TS RNG.

**Narration convention (the assistant reports; the DM narrates):** emit a markdown report every turn;
never put numbers (HP/damage/totals) in player-visible `send_narration`; narrate round-end with
effect countdowns; dead tokens → mark dead + move to the map layer; emanations (Spirit Guardians) use
a token **aura**, fixed areas use `create_zone`. Full rules: `skills/dm-rules.md`.

**DDB monster lookup lives in beyond-mcp now** — its `ddb_get_monster` / `ddb_get_party_snapshot`
(the latter carries site-computed AC + max HP for a whole party in one call). Nothing in this repo
talks to D&D Beyond.
