# DM Whisper — End-to-End Human Test Script

A manual, human-followable runbook that exercises **every feature** of the
roll20-dm-mcp stack: campaign setup, the Mod relay, map prep, token rostering,
the full combat loop (HP, conditions, **AoE spells, bulk saving throws,
emanations, zone management**), the live chat stream, and the voice HUD gem —
and then an **LLM-as-judge** phase that scores the assistant's prompting and tool
usage.

> **Who runs this:** a developer with the repo checked out and a live Roll20
> campaign. Expect ~60–90 min for a full pass.

> **v2.0.0 scope (2026-08-26).** This repo is Roll20 primitives and nothing else:
> - **No browser anywhere.** `playwright` is not a dependency; there is no chromium
>   step, no screenshots, no DOM automation. If it can't be done without a browser,
>   it isn't a tool here.
> - **No D&D Beyond.** All seven `ddb_*` tools, `full_sync_character`, and
>   `sync_character_state` are gone. [beyond-mcp](https://github.com/eschatus/beyond-mcp)
>   owns DDB now and serves **identical tool names** — run it alongside if you want
>   DDB reads during this script (its own test coverage lives in that repo).
> - **No tactics.** `plan_tactics` / `plan_all_tactics` / `record_tactic_outcome` /
>   `get_tactic_memory` / `clear_tactic_memory` are gone. The gem plans; this server
>   only **stores** plans (`set_mob_plan` / `get_mob_plans` / `clear_mob_plans`).
> - **No player-command answering.** `!tactics` / `!recall` / `!recap` / `!options` /
>   `!rules` are not handled here. The server **forwards** table chat as an SSE
>   `chat-message` event; the gem answers.
> - **Credentials are furnished, never minted.** The server reads
>   `roll20-rt-token.json` and `roll20-upload-cache.json` from the data dir and never
>   harvests either. The gem is the sole harvester.
> - **Mod deploy is a human-attended paste.** `deploy_mod_script` and
>   `npm run release:mod` are deleted.

---

## Conventions

- Each step has an **action**, the **expected result**, and a **PASS/FAIL** box.
- `[ ]` = check it off as you go. Record failures inline with the actual output.
- **Tool calls** are written `tool_name { param: value }`. You can drive them three ways:
  - **(A) Chat-driven** — type natural language to Claude (in the IDE or the gem);
    Claude picks the tool. This is what the *judge* phase evaluates.
  - **(B) Direct** — call the MCP tool explicitly (e.g. from the MCP inspector or
    a scripted client) when you want a deterministic check, not an LLM decision.
  - **(C) Voice** — hold PTT in the gem and speak (Phase 7).
- **⚠ MUTATES** marks a tool that writes live Roll20 state. **🔒 SAFE** = read-only
  or local registry only.

### The test campaign (read this before starting)

This script **provisions a throwaway campaign** so nothing here touches a live
game. The combat scenario uses a **fixed, known roster with checkable HP/AC** so
you can verify the math, not just that "a tool ran." If you'd rather reuse the
standard soak campaign, **DRW-Original** (`dreamsofredwizards-original`, Roll20
ID `17491327`) is the project's control campaign (no real PCs) — skip Phase 1's
*register* step and just `switch_campaign` to it.

**Known roster used throughout (provisioned in Phase 3):**

| Token | Kind | HP | AC | Notes |
|---|---|---|---|---|
| **Thorne** | PC (player-controlled) | 30 | 16 | exercises PC HP routing (`adjustPcHp`, never bar1) |
| **Goblin A–D** | NPC | 7 each | 15 | the AoE / bulk-save cluster |
| **Ogre** | NPC | 59 | 11 | single-target damage + dead-token handling |
| **Mastermind** | NPC | 40 | 17 | the mob whose plan gets stored/read back in Phase 4 |

> **AC caveat:** `create_npc_token` / `create_monster_token` accept `ac` but **report it
> back only** — `createToken` doesn't set `represents`, so a bare token has no sheet to
> hold AC and nothing is written. Track AC on paper for this run.

---

## Phase 0 — Environment & prerequisites

| # | Action | Expected | ✓ |
|---|---|---|---|
| 0.1 | `node --version` | ≥ v20 | [ ] |
| 0.2 | `npm install` (repo root) | clean install. **No `npx playwright install` step** — confirm `playwright` is absent from `package.json` dependencies | [ ] |
| 0.3 | Confirm `.env` has `ANTHROPIC_API_KEY` | Needed **only** by the maps suite's `analyze_battlemap` (`src/tools/vision.ts` is the sole `@anthropic-ai/sdk` importer). The combat server reaches no Anthropic code — skip this if you skip Phase 2. **No DDB credential is needed or used.** | [ ] |
| 0.4 | Confirm the data dir holds a **current** `roll20-rt-token.json` for the campaign you're about to test | `{campaignId, customToken, databaseURL, harvestedAt}`, < 50 min old, **matching this campaign** (tokens are campaign-scoped). The server never harvests one — refresh it from the gem. Data dir = `./data` unless `ROLL20_DATA_DIR` is set. | [ ] |
| 0.5 | If you'll run Phase 2: confirm `roll20-upload-cache.json` too | `{endpoint, cookies, harvestedAt}`, < 8 h old. Missing/stale → `Roll20UploadCredentialError` on any upload. | [ ] |
| 0.6 | `npm run build` | `tsc` exits 0 (required for the stdio maps server + `npm start`) | [ ] |
| 0.7 | `npm test` | suite green — **34 files, 400 tests passing, 0 skipped** as of v2.0.0 | [ ] |
| 0.8 | `npm run serve` | HTTP server boots; first run generates `ROLL20_MCP_TOKEN`, writes `.env`, injects `.mcp.json` | [ ] |
| 0.9 | Note the `ROLL20_MCP_TOKEN` value | needed by the gem later | [ ] |

**PASS criteria:** server is listening on `:39200`, token exists. If 0.7 fails on
`_ is not defined`, the emulator's underscore shim regressed — stop and fix first.

**Negative check (the furnished-credential contract):** temporarily move
`roll20-rt-token.json` aside and call any combat tool. It must fail with a typed
`Roll20TokenUnavailableError` naming what to refresh — **not** hang, and **not**
quietly try to open a browser. `[ ]`

---

## Phase 1 — New campaign setup & the Mod relay

> Exercises: `register_campaign`, `switch_campaign` (+ the **switch-then-wait**
> rule), the Mod relay deploy (MANUAL — paste into the API console, #175), the **soak test**, and
> `transport_status`.

| # | Action | Expected | ✓ |
|---|---|---|---|
| 1.1 | (A) "Register a campaign named *E2E Test* with Roll20 id `<your test campaign id>`" → `register_campaign { name, roll20CampaignId }` ⚠ | confirms, returns slug `e2e-test` | [ ] |
| 1.2 | (A) "Switch to e2e-test" → `switch_campaign { slugOrName: "e2e-test" }` ⚠ | switches **and then STOPS** — the assistant must **wait for your confirmation** before any further tool call (rule: `skills/dm-rules.md` "switch then wait"). Registry-only now: there is no browser to navigate. | [ ] |
| 1.3 | **Judge checkpoint:** did the assistant correctly *not* chain another tool after the switch? | yes = PASS | [ ] |
| 1.4 | Confirm "go ahead" → `active_campaign` 🔒 | shows e2e-test active | [ ] |
| 1.5 | **Deploy the Mod relay BY HAND**: open the campaign's API/Mod console, paste `mod-scripts/ai-relay.js`, save ⚠ | Mod console prints `[GM_AI_Bridge] Relay script loaded (v2.7.0)`. **Verify the LOAD, not the save** — a saved-but-crashed script looks identical if you only check the save. Deploys are **per-campaign**: a campaign you haven't pasted into is running an old relay, or none. | [ ] |
| 1.6 | `npx tsx src/recon/soak-test.ts` | round-trip `pong`, direct reads, scratch-token create, **PC-HP via `adjustPcHp`**, batchExec, conditions, dice engine, cleanup — all pass, exit 0 | [ ] |
| 1.7 | (A) "transport status" → `transport_status` 🔒 | RT healthy; **circuit breaker closed**; counters present; active campaign = e2e-test; **relay version handshake reports 2.7.0** with no mismatch warning (a mismatch means 1.5 didn't take) | [ ] |

**Negative/safety check:**

| 1.8 | Force three RT failures (e.g. disconnect the token), then call any tool 4×. | After 3 consecutive failures the breaker **opens**; the 4th call **fails fast** with "circuit open … reconnect Roll20 in the gem," not a 30s hang. After 30s a single probe is allowed; a failed probe re-opens immediately. | [ ] |

> If you don't want to simulate a token failure, skip 1.8 and just confirm
> `transport_status` reports the breaker fields exist.

---

## Phase 2 — Map prep pipeline (image → playable lit map)

> Exercises the **maps server** (`roll20-dm-maps`, stdio): `analyze_battlemap`
> → `setup_roll20_page` → `upload_and_place_map_image` → `auto_place_dl_walls`
> → `decorate_openings`. Skip to Phase 3 if you reuse an existing page.

Put a battlemap PNG in `data/maps/` (e.g. `e2e-arena.png`). Use a **unique
filename** — upload dedups by name.

| # | Action | Expected | ✓ |
|---|---|---|---|
| 2.1 | `analyze_battlemap { imagePath: "data/maps/e2e-arena.png", pipeline: "two-pass" }` 🔒 | returns `gridSizePx`, `gridOffsetX/Y`, `imageDimensions` (W×H), `walls[]`, `doors[]`, `windows[]`, `secretDoors[]`; auto-saves `e2e-arena.analysis.json`; `model: claude-sonnet-4-6` | [ ] |
| 2.2 | Derive page size: `widthSquares = round((W − offsetX)/gridSizePx)`, `heightSquares = round((H − offsetY)/gridSizePx)` | sane integers | [ ] |
| 2.3 | `setup_roll20_page { name: "E2E Arena", widthSquares, heightSquares, scaleNumber: 5, scaleUnits: "ft" }` ⚠ | page created **browserlessly** via `rtCreatePage` (RTDB write mirroring an existing page's schema — `createPageViaUI` is deleted, and `createObj("page")` is still unsupported in the sandbox); returns `pageId` | [ ] |
| 2.4 | `upload_and_place_map_image { pageId, imagePath, widthSquares, heightSquares }` ⚠ | background on the **map** layer; returns `graphicId` | [ ] |
| 2.5 | `auto_place_dl_walls { pageId, walls, doors, windows, sourceImageWidth: W, sourceImageHeight: H, pageWidthSquares, pageHeightSquares, strokeColor: "#0044FF" }` ⚠ | DL walls placed in **blue**. **GOTCHA: you MUST pass `#0044FF`** — the default is yellow `#FFFF00`. | [ ] |
| 2.6 | `decorate_openings { pageId, doors, windows, secretDoors, sourceImageWidth: W, sourceImageHeight: H, pageWidthSquares, pageHeightSquares }` ⚠ | native DL **doors #FF0000 / windows #00FFFF / secret #9932CC** | [ ] |
| 2.7 | `get_walls { pageId, includePoints: true }` and `get_doors { pageId }` 🔒 | counts match what 2.5/2.6 reported; wall vertices land inside the page's pixel bounds. **`screenshot_roll20` is removed** — verification is now numeric here plus your own eyes on the Roll20 tab | [ ] |
| 2.8 | Look at the page in Roll20 with the DL layer visible | walls + openings track the art | [ ] |

**PASS criteria:** the built map's walls/doors visually track the art. Misaligned
walls usually mean the source-image dims weren't passed to 2.5/2.6.

---

## Phase 3 — Token roster (known, checkable)

> Exercises `create_pc_token`, `create_npc_token`, `create_monster_token`, and
> `list_tokens`. **All three creation tools take caller-supplied stats and perform no
> lookup of their own** (#171) — there is no compendium/DDB path and therefore no 404
> fallback. Resolve stats first (beyond-mcp, a stat block, whatever) and pass them in.

| # | Action | Expected | ✓ |
|---|---|---|---|
| 3.1 | **PC:** `create_pc_token { name: "Thorne", hp: 30, controlledBy: "<a Roll20 player id>", pageId, gridX: 5, gridY: 5 }` ⚠ | token created and registered; `controlledby` set via the follow-up `setTokenProps`, which is what makes `isPcToken` true and PC HP/death routing apply. **Without `controlledBy` it routes as an NPC** — the tool says so in its result. `ddbCharId` is optional and recorded for linkage only, never fetched. | [ ] |
| 3.2 | **Cluster:** `create_npc_token { name: "Goblin A", hp: 7, ac: 15, pageId, gridX, gridY }` ×4 (A–D), placed adjacent | 4 goblins, bar1 = 7/7. `ac` comes back in the text as "not stored — no sheet on a bare token" | [ ] |
| 3.3 | **Bruiser:** `create_npc_token { name: "Ogre", hp: 59, ac: 11, pageId }` ⚠ | bar1 = 59/59 | [ ] |
| 3.4 | **Monster variant:** `create_monster_token { monsterName: "Goblin", hp: 7, ac: 15, cr: "1/4" }` ⚠ | creates from the stats YOU passed. Same bare token as 3.2 — the difference is only the wording of the result; `ac`/`cr` are reported, not stored | [ ] |
| 3.5 | **Mastermind:** `create_npc_token { name: "Mastermind", hp: 40, ac: 17 }` ⚠ | placed | [ ] |
| 3.6 | `list_tokens { pageId }` 🔒 | all tokens listed with name/layer/controlledby/hp; Thorne shows a player in `controlledby`, NPCs blank | [ ] |
| 3.7 | **Sidekick routing (optional):** `set_token_class { characterName: "<a PC-controlled token>", tokenClass: "sidekick" }` 🔒 (registry only) | the token stays player-controlled but now routes as an NPC everywhere HP/death is decided (bar1, `kill_token`, no dying state) — issue #132. Revert with `tokenClass: "pc"` before Phase 5 unless you want to test that path. | [ ] |

---

## Phase 4 — Start combat

> Exercises `roll_initiative` (PC-safe, incl. the `entries` overrides), the **turn hook**
> (armed inside `roll_initiative`), the **mob-plan store**, and `get_turn_order`.
> Follow `/combat`.

| # | Action | Expected | ✓ |
|---|---|---|---|
| 4.1 | (A) `get_current_page` then `list_tokens` 🔒 | reports page + roster. `get_current_page` reads `playerpageid` straight off RTDB — no browser | [ ] |
| 4.2 | `roll_initiative { npcOnly: true, clearFirst: false }` ⚠ | NPC inits rolled via Roll20 public dice and **merged** (never wholesale); **PC inits untouched**; turn hook auto-armed; barless NPCs HP-initialized | [ ] |
| 4.3 | **Judge checkpoint:** confirm the assistant used `npcOnly: true` and did **not** roll or overwrite Thorne's initiative. | PASS if PC init read-only | [ ] |
| 4.4 | **Explicit overrides (#172):** `roll_initiative { npcOnly: true, entries: [{"match":"Ogre","bonus":-1,"hp":59},{"match":"Goblin","bonus":2}] }` ⚠ | `bonus` rolls `1d20+bonus` through the Roll20 roller, **beating** any sheet-derived bonus; `hp` seeds bar1/bar1_max before rolling (NPCs and sidekicks only — PCs never touched). `match:"Goblin"` matches **all four** goblins. Any entry that matched nothing comes back in `entriesUnmatched` | [ ] |
| 4.5 | `get_turn_order` 🔒 | ordered list, names resolved, Thorne present and unchanged | [ ] |
| 4.6 | `check_turn_hook` 🔒 | enabled, round 1 | [ ] |

**Mob plans — storage only, no planning here.** The tactics tools are gone; the gem
does the thinking and parks the result via these three:

| # | Action | Expected | ✓ |
|---|---|---|---|
| 4.7 | `set_mob_plan { characterName: "Mastermind", shortTerm: "Hold the doorway, ready a spell", mediumTerm: "Fall back to the stairs at half HP", longGoal: "Survive to warn the master" }` ⚠ | plan stored in relay state; a whisper card auto-renders; a `mob-plan` SSE event fires on `/events` | [ ] |
| 4.8 | `get_mob_plans` 🔒 | returns `tokenId → { html, plan }` with exactly what 4.7 stored — **the server never generates or edits a plan** | [ ] |
| 4.9 | Advance to the Mastermind's turn | the stored card is whispered to the DM on that token's turn | [ ] |
| 4.10 | `set_mob_plan { characterName: "Mastermind", clear: true }` ⚠ then `clear_mob_plans` ⚠ | single clear, then the encounter-end wipe; the `mob-plan` SSE event carries `plan: null` on a clear. Leaving stale plans behind means an old fight's tactics resurface in the next one | [ ] |

> **Removed — do not test:** `plan_tactics`, `plan_all_tactics`, `record_tactic_outcome`,
> `get_tactic_memory`, `clear_tactic_memory`, and the Int/Wis→tier→model cascade that
> went with them. Model selection for tactics is now the gem's business and is scored
> in its repo, not here. (Historical: the tier table keyed off `(Int+Wis)/2`, ≤5 t0
> through >20 t5.)

---

## Phase 5 — The turn loop (you narrate; the assistant reports & applies)

This is the core. **You play DM and narrate**; the assistant must emit a
**markdown report every turn** and apply changes with the right tools. Follow
`/round`. Drive these via **chat (A)** so the judge can score the decisions.

### 5A — Single-target HP & the PC/NPC routing split

| # | You narrate | Expected assistant behavior | ✓ |
|---|---|---|---|
| 5A.1 | "Thorne takes 12 slashing from the ogre." | `update_token_hp { characterName: "Thorne", damage: 12 }` → routes to **`adjustPcHp`** (relay state / gmnotes), **bar1 NOT written**, reported `(tracked)`. **A PC token bar must never be written.** ⚠ | [ ] |
| 5A.2 | "The ogre takes 20 from Thorne's maul." | `update_token_hp { characterName: "Ogre", damage: 20 }` → NPC → **bar1** 59→39 | [ ] |
| 5A.3 | Verify | `get_token { tokenId: <Ogre> }` shows bar1 = 39; Thorne's HP shows in the gmnotes block, bar untouched | [ ] |
| 5A.4 | **Judge checkpoint** | Did it route PC vs NPC correctly and keep numbers out of any player-visible channel? | [ ] |

### 5B — Conditions / markers

| 5B.1 | "Thorne is poisoned." | `set_token_marker { characterName: "Thorne", condition: "poisoned", active: true }` → custom marker `Poisoned::4444329` ⚠ | [ ] |
| 5B.2 | "Goblin A is prone." | marker applied; `get_token_markers` 🔒 shows RESERVED vs AVAILABLE | [ ] |
| 5B.3 | Bulk (2+ tokens) | Assistant uses `batch_exec` (not N single calls) per the bulk-ops rule ⚠ | [ ] |

### 5C — AoE spell + bulk saving throws  ⭐ (your requested feature)

The headline test: a **Fireball** on the goblin cluster, with Thorne caught in
the edge. Bulk saves are rolled through Roll20's **public** dice; **PCs in the
area are report-only** (they roll their own saves).

| # | You narrate | Expected | ✓ |
|---|---|---|---|
| 5C.1 | "Fireball centered on the goblins — 8d6 fire, DEX save DC 15, half on save." | `resolve_aoe { label: "Fireball", centerTokenName: "Goblin A", radiusFeet: 20, saveAbility: "dexterity", saveDc: 15, damageFormula: "8d6", halfOnSave: true, draw: "zone" }` ⚠ — **`saveAbility` is the full word** (`strength`…`charisma`); `"dex"` is a schema error. The effect name is `label`, not `spellName`. | [ ] |
| 5C.1b | "Fireball lands *there*" — shift+click the map, then narrate | `resolve_aoe { label: "Fireball", atPing: true, radiusFeet: 20, … }` centers on the GM's last map ping (within 3 min) and draws a zone at the spot | [ ] |
| 5C.2 | Watch chat | **one batch of public Roll20 saves** (one per NPC), full damage on fail / half on save, applied to each goblin's bar1; a red **zone** drawn at the footprint | [ ] |
| 5C.3 | Thorne in range | Thorne is **reported only** ("Thorne is in the area — roll your DEX save"), **not auto-damaged** | [ ] |
| 5C.4 | `dryRun` variant | "Preview the fireball first" → `resolve_aoe { …, dryRun: true }` 🔒 — lists targets/expected damage **without rolling or applying** | [ ] |
| 5C.5 | Healing variant | "Mass cure on the goblins, 2d8+3" → `resolve_aoe { …, healing: true, damageFormula: "2d8+3" }` — **does** heal (incl. PCs via `adjustPcHp`), no save/condition ⚠ | [ ] |
| 5C.6 | **Judge checkpoint** | Right primitive (`resolve_aoe`), PCs report-only on damage, dice via Roll20, no numbers leaked to players. | [ ] |

### 5D — Emanations (token aura)  ⭐ (your requested feature)

Emanations move with the caster → **aura**, not a fixed zone.

| # | You narrate | Expected | ✓ |
|---|---|---|---|
| 5D.1 | "Thorne casts Spirit Guardians, 15-ft emanation." | `set_token_props { tokenId: <Thorne>, aura1_radius: 15, aura1_color: "#ffff00", showplayers_aura1: true }` — **aura**, NOT `create_zone` ⚠ | [ ] |
| 5D.2 | "A goblin starts its turn in the guardians — 3d8 radiant, CON save DC 15 half." | bulk save on the affected token(s) via `resolve_aoe { …, centerTokenName: "Thorne", radiusFeet: 15, draw: "aura" }` or `find_tokens_in_range` + `update_hp_many` | [ ] |
| 5D.3 | Move Thorne, re-check | the aura travels with the token (emanation semantics) | [ ] |
| 5D.4 | **Judge checkpoint** | Did it pick **aura** (not zone) for the emanation? | [ ] |

### 5E — Zone management (fixed areas)  ⭐ (your requested feature)

Fixed AoEs that stay put → **zones**.

| # | You narrate | Expected | ✓ |
|---|---|---|---|
| 5E.1 | "Web fills a 20-ft cube by the door." | `create_zone { name: "Web", shape: "rect", widthFeet: 20, heightFeet: 20, centerX, centerY, color: "#ffffff" }` ⚠ | [ ] |
| 5E.2 | `list_zones { pageId }` 🔒 | shows "Web" (and the Fireball zone if still up) | [ ] |
| 5E.3 | "Cloudkill, 20-ft radius circle, centered on the ogre." | `create_zone { name: "Cloudkill", shape: "circle", centerTokenId: <Ogre>, radiusFeet: 20, color: "#88cc88" }` ⚠ | [ ] |
| 5E.4 | "The web is gone." | `clear_zone { name: "Web" }` ⚠ | [ ] |
| 5E.5 | **Judge checkpoint** | Fixed area → zone (not aura); named correctly; cleared on dismissal. | [ ] |

### 5F — Death, narration discipline, round end

| # | You narrate | Expected | ✓ |
|---|---|---|---|
| 5F.1 | "The ogre drops." | **`kill_token { characterName: "Ogre" }`** ⚠ — one call does the whole death procedure (dead marker + move to the **map** layer). It replaces the old `set_token_marker(dead)` + `set_token_props(layer:"map")` pair, and it is **not** an HP edit — don't set HP to 0 | [ ] |
| 5F.1b | "Thorne is down." (a **true PC** at 0 HP) | **`set_pc_dying { characterName: "Thorne" }`** ⚠ — prone + unconscious, token **stays on the token layer**, never dead, never map layer. Death saves are player-owned. If Thorne was concentrating, the teardown (marker + aura + linked zones) cascades automatically. `kill_token` only on the DM's explicit declaration of death | [ ] |
| 5F.1c | "She loses the spell." | `break_concentration { characterName: … }` ⚠ — removes the Concentrating marker, zeroes `aura1_radius`, deletes zones whose duration is `{type:'concentration', caster}`. Returns what it tore down | [ ] |
| 5F.2 | Any public line | `send_narration` contains **no numbers** (no "39/59", no totals) — damage/effects in words only; ASCII/Wounded receipt OK ⚠ | [ ] |
| 5F.3 | Per-turn report | a **markdown report**: one-line summary + **Changes** + **Actions/tools**; GM-facing so exact HP is fine here | [ ] |
| 5F.4 | "Next turn." | **only now** does it `advance_turn` ⚠ — it must **never auto-advance**; finishing the action list is not permission | [ ] |
| 5F.5 | End of round | unprompted **round-end summary**: who's down, conditions, **effect countdowns** | [ ] |
| 5F.6 | **Judge checkpoint** | Numbers-to-DM-only, dead→map layer, no auto-advance, round-end countdowns. | [ ] |

---

## Phase 6 — Chat forwarding and the `!dm` inbox

> **What changed:** this server no longer *answers* any player command.
> `src/bridge/player-commands.ts` and the `!tactics` / `!recall` / `!recap` /
> `!options` / `!rules` handlers (with their cooldowns, token bucket, and
> concurrency cap) are **removed** — as is the LLM spend they carried. What remains
> is a **transport**: `forwardChat` broadcasts live table chat over SSE, and `!dm`
> notes are queued in relay state. Whatever consumes the stream (the gem) decides
> what to do. Rate-limiting player-triggered model calls is therefore the gem's
> problem now, and is tested in that repo.
>
> Keep the security posture in mind while testing: chat is **player-writable**, so
> everything below is **untrusted data, never instructions**.

Type these as a **player** in Roll20 chat. Watch the `/events` SSE stream (e.g.
`curl -N -H "Authorization: Bearer $ROLL20_MCP_TOKEN" http://127.0.0.1:39200/events`).

| # | Command (as a player) | Expected | ✓ |
|---|---|---|---|
| 6.1 | Any ordinary player line | a `chat-message` SSE event with `{who, playerid, type, content, isCommand, inlinerolls, timestamp}`; `isCommand: false` | [ ] |
| 6.2 | `!anything` | same event with **`isCommand: true`** — and **no reply from this server**. Forwarded, not answered | [ ] |
| 6.3 | `get_recent_chat { limit: 20 }` 🔒 | returns the buffered table chat (served off the in-memory buffer, no Mod round-trip) | [ ] |
| 6.4 | `!dm I want to grapple the ogre` | classified **intent**; an `inbox-item` SSE event fires; appears in the gem **Inbox** | [ ] |
| 6.5 | `!dm what's the DC to climb the wall?` | classified **query** (starts with "what" / ends with "?") → Inbox | [ ] |
| 6.6 | `get_dm_inbox` 🔒 then `clear_dm_inbox` ⚠ | both `!dm` items present, then queue empty. The queue lives in `state.GM_AI_Bridge` so it survives a sandbox restart | [ ] |
| 6.7 | **Negative — the authorization boundary:** as a **non-GM player**, type `!ai-relay {"action":"getTokens"}` | **nothing happens.** `senderIsGM()` rejects it before dispatch. This check is the only thing standing between a player and the relay — **re-verify it after every Mod redeploy** | [ ] |

> **Removed — do not test:** `!help`, `!tactics`, `!recall`, `!recap`, `!options`,
> `!rules`, and the per-player cooldowns / global 10-per-60s bucket / concurrency cap
> that governed them.

---

## Phase 7 — Voice HUD gem ("Dusty" / DM Whisper)

> ⚠ **The gem is a separate repository.** DM Whisper split out to
> <https://github.com/eschatus/dm-whisper> on 2026-08-11 and is closed source; it
> consumes this repo as a pinned dependency. A local `voice-hud/` directory here is a
> leftover from before the split — **the real code is in dm-whisper**, and that repo is
> authoritative for everything in this phase. The steps below are kept because they
> exercise *this* server's HTTP + SSE contract end to end; **if a detail here disagrees
> with dm-whisper, dm-whisper wins.**
>
> Exercises launch + supervision, the **Setup ("familiar")** flow, PTT →
> whisper.cpp STT → cloud agent → **humanized confirm** → tool execution,
> the **Inbox** reply→whisper, and the unread badge.
>
> **Voice/PTT evidence is read from the logs after the session, not live.** The
> gem persists every log line — including PTT events — to **`hud.log`** (JSONL
> `{ts, level, kind, msg}`) under `DMW_DATA_DIR` (packaged: Electron `userData`).
> It survives the detached launch. So just *do* the voice steps below, then review
> the log afterward:
>
> - **PTT timing/watchdog:** `grep "\[ptt\]" hud.log` → you'll see `PTT down`,
>   `PTT up (held <ms>ms)`, and any `PTT force-released …` (max-hold or sweep) lines.
> - **STT accuracy/correction:** before launching, set **`DMW_SAVE_CLIPS=1`** to
>   keep the A/B corpus under `data/ab-clips/` — each clip writes `.wav` + a
>   `.draft.txt` (raw STT) you can diff against the corrected final. (`npm run ab:stt`
>   scores a corpus.) Tool calls and confirms are also in `hud.log` (`grep` the
>   tool names / `[ptt]`).

### 7A — Launch & setup

| # | Action | Expected | ✓ |
|---|---|---|---|
| 7.1 | Ensure the MCP server is up on `:39200` with `ROLL20_MCP_TOKEN`; launch the gem from the **dm-whisper** checkout (see that repo's README for the current launcher) | gem window appears; connects MCP + SSE `/events` | [ ] |
| 7.2 | Open the **Setup** tab | status shows dataDir, **API key**, **RT token**, campaign count, active slug; a `!` badge until essentials done, then a green "You're all set" | [ ] |
| 7.3 | If needed: enter Anthropic key; **Connect Roll20** (first-party token harvest in the gem's own Electron session — not OAuth); optionally pick a larger STT model / enable GPU; **copy the Mod** to clipboard | each step flips its status green | [ ] |
| 7.4 | **The harvest contract:** confirm Connect Roll20 refreshes `roll20-rt-token.json` (and the upload cache) in the dir this server reads | the gem is the **sole harvester**; this server only reads those files and raises `Roll20TokenUnavailableError` / `Roll20UploadCredentialError` when they're absent or stale. Whether the gem also connects D&D Beyond (for beyond-mcp) is **dm-whisper's business, not this repo's** | [ ] |
| 7.5 | Say/type "list my campaigns" → switch to **e2e-test** | active campaign = e2e-test | [ ] |

### 7B — A voice turn + confirm flow

| # | Action | Expected | ✓ |
|---|---|---|---|
| 7.6 | **Hold Right-Ctrl** and speak: "the ogre takes ten damage" (release to send) | state goes **listening → scrying**; live partials stream into the caption; the **final** transcript is corrected (notation/literal/fuzzy) | [ ] |
| 7.7 | Watch the confirm bubble | the write is **humanized**: e.g. "deal 10 damage to the Ogre" with hint "**Right-Shift to confirm · Esc to cancel**" (token IDs → roster names) | [ ] |
| 7.8 | Press **Right-Shift** | tool executes (Ogre bar1 −10); report renders in the ledger | [ ] |
| 7.9 | Repeat, then press **Esc** at the confirm | action **cancelled**, no write | [ ] |
| 7.10 | STT correction spot-check: speak a campaign proper noun (add it via the **Proper Nouns** tab first) and a split name | correction layer fixes it on the committed transcript (partials may show raw) | [ ] |
| 7.11 | **PTT watchdog:** hold, then (simulate) a missed key-up | recording **force-releases** within `DMW_PTT_STALE_MS` (2500ms) / by `DMW_PTT_MAX_HOLD_MS` (75s) — no runaway re-transcription. **Verify after** in `hud.log`: `grep "\[ptt\]"` shows `PTT down` then `PTT force-released …`. | [ ] |

### 7C — Inbox

| # | Action | Expected | ✓ |
|---|---|---|---|
| 7.12 | Trigger 6.4/6.5 so `!dm` items arrive | the medallion crescent shows an **unread badge**; the **Inbox** tab shows `(N)` | [ ] |
| 7.13 | Open **Inbox**, type a reply, click **Reply** | calls `whisper_player` → the player gets a whisper; item marked handled; badge clears | [ ] |
| 7.14 | With Inbox open, **dictate** a reply (hold PTT) | dictation routes into the focused **reply input**, not the chatbox | [ ] |

### 7D — Model discipline (for the judge)

| # | Action | Expected | ✓ |
|---|---|---|---|
| 7.15 | Simple turn ("goblin A takes 3") vs complex multi-target narration | model choice, escalation, and any local-LLM toggle are **dm-whisper's** configuration — check that repo for the current defaults before scoring D3. Nothing in *this* server selects a model (its only Anthropic caller is the maps suite's `analyze_battlemap`). | [ ] |

---

## Phase 8 — D&D Beyond — REMOVED from this repo

There is nothing to test here any more. The whole DDB bridge left in v2.0.0:
`ddb_get_character`, `ddb_get_monster`, `ddb_list_campaigns`,
`ddb_list_campaign_characters`, `start_ddb_roll_pump`, `stop_ddb_roll_pump`,
`ddb_roll_pump_status`, plus `full_sync_character` and `sync_character_state`.
No `CobaltSession` or any other DDB credential exists in this repo.

[beyond-mcp](https://github.com/eschatus/beyond-mcp) owns D&D Beyond now and serves
**identical tool names**, so a DM runs both servers side by side and nothing about
the tool-call surface changes. Test it from that repo.

| # | Action | Expected | ✓ |
|---|---|---|---|
| 8.1 | List this server's tools (MCP inspector, or the client's tool list) | **no tool whose name starts with `ddb_`**, and no `full_sync_character` / `sync_character_state` | [ ] |
| 8.2 | `grep -ri cobalt src/` | no hits — no DDB credential path exists | [ ] |
| 8.3 | If you run beyond-mcp alongside: `ddb_get_monster { … }` from *that* server | resolves; feed the HP/AC it returns into `create_npc_token` / `create_monster_token` by hand — **this server never looks anything up** | [ ] |

---

## Phase 9 — Cleanup

| # | Action | Expected | ✓ |
|---|---|---|---|
| 9.1 | `set_turn_hook { enabled: false }` ⚠ | hook off | [ ] |
| 9.2 | `clear_zone` each remaining zone (Fireball/Cloudkill) ⚠ | zones gone | [ ] |
| 9.3 | Clear auras: `set_token_props { tokenId: <Thorne>, aura1_radius: 0 }` ⚠ | emanation cleared | [ ] |
| 9.4 | `clear_turn_order` ⚠ (between-encounter wipe — destructive by design) | order cleared | [ ] |
| 9.5 | `clear_mob_plans` ⚠ | no stale plan survives into the next encounter (a leftover plan gets whispered again when that token's turn comes round) | [ ] |
| 9.6 | `clear_dm_inbox` ⚠ | `!dm` queue emptied | [ ] |
| 9.7 | `remove_object` the test tokens ⚠ | board clean. **Page deletion is not a tool** — `page.remove()` isn't supported by the API and there's no browser; delete the test page yourself in the Roll20 page navigator | [ ] |
| 9.8 | `remove_campaign { slugOrName: "e2e-test" }` 🔒 (registry only) | de-registered | [ ] |

---

## Phase 10 — LLM-as-judge: scoring prompting, models & tool usage

The point of simulating narration is to **evaluate the assistant's decisions**.
This phase defines what to capture, the rubric, a ready-to-paste judge prompt,
and a scoring sheet.

### 10.1 What to capture (during Phases 4–7)

For each narrated turn, save:
1. **Your narration** (the DM input verbatim).
2. **The assistant's markdown report** (one-line summary + Changes + Actions).
3. **The tool calls** — name + params (from the report's Actions block, or the
   gem's tool-start/tool-result stream, or the MCP server logs).
4. **Player-visible output** — every `send_narration` / whisper text.
5. **Model used** where relevant — the gem's agent model. (There is no tactics
   tier/model to capture any more; nothing in this server selects a model.)

> The gem already streams `onToolStart` / `onToolResult` and renders a per-turn
> report; the IDE shows tool calls inline. Either is a fine capture source.
>
> **For the gem/voice turns, capture post-hoc from the logs** rather than live:
> `hud.log` (under `DMW_DATA_DIR`) holds the tool calls, confirms, and `[ptt]`
> events; `data/ab-clips/*.draft.txt` (with `DMW_SAVE_CLIPS=1`) holds the raw vs
> corrected STT for **D6**. Run the combat, then read the log and feed the
> relevant lines to the judge.

### 10.2 Rubric (score each 1–5; cite evidence)

| Dim | What "5" looks like | Common failures (≤2) |
|---|---|---|
| **D1 — Tool selection** | Right tool for the intent; `resolve_aoe` for AoE, aura for emanation, zone for fixed area; `batch_exec` for 2+; reads before writes. | Hand-rolled HP math instead of `roll_dice`; N single calls instead of batch; `create_zone` for an emanation. |
| **D2 — Param correctness & HP routing** | Three-way routing: PC→`adjustPcHp` (never bar1), NPC **and sidekick**→bar1; correct save ability (full word: `dexterity`, not `dex`) / DC / formula; `npcOnly:true` for init. | Writing a true PC's bar; routing a sidekick as a PC; `saveAbility:"dex"`; wholesale `setTurnOrder`. |
| **D3 — Model appropriateness (gem only)** | The gem's own model-selection policy — **scored against dm-whisper's current defaults**, since no model choice happens in this server. | Needless escalation on a trivial single-target turn. |
| **D4 — Narration discipline** | **No numbers** in player-visible text; per-turn GM report present & well-formed; round-end countdowns; persona consistent (Dusty in the gem). | HP totals leaked to players; missing report; dramatic recap instead of a mechanical round-end. |
| **D5 — Safety & procedure** | Switch-then-wait; confirm before writes (gem); **never auto-advance**; death via `kill_token`, a downed PC via `set_pc_dying`; no wholesale turn-order writes. | Auto-advancing turns; chaining tools after `switch_campaign`; `kill_token` on a downed PC; zeroing HP instead of `kill_token`; skipping confirms. |
| **D6 — STT/correction (gem only)** | Proper nouns & notation corrected on the committed transcript; no corruption of ordinary words. | Right name mis-transcribed despite being in vocab; over-correction of common words. |

### 10.3 Judge prompt (paste into a fresh Claude/Opus session per turn or per session)

```
You are an adversarial evaluator of an AI Dungeon Master assistant for D&D 5e on
Roll20. You are given: (1) the DM's narration, (2) the assistant's markdown
report, (3) the exact tool calls it made (name + params), (4) all player-visible
text it emitted, and (5) any model/tier it selected.

Score each dimension 1–5 and cite the specific evidence (quote the tool call or
the text). Be strict: a plausible-but-wrong choice is a 2, not a 4.

Reference facts you must enforce:
- HP routing is THREE-way. True PCs (player-controlled, no sidekick override) must
  have HP changed via adjustPcHp / update_token_hp routing to relay state — NEVER a
  write to bar1. NPCs AND sidekicks (player-controlled but flagged sidekick in the
  characters registry) are bar1.
- Death: kill_token for an NPC/sidekick death or a DM-declared PC death — it is the
  whole procedure (dead marker + map layer) in one call, and is NOT an HP edit.
  A true PC dropping to 0 is set_pc_dying (prone + unconscious, stays on the token
  layer, death saves are player-owned). Zeroing HP is not a death.
- AoE → resolve_aoe (rolls NPC saves via Roll20 public dice; PCs in a *damage*
  area are report-only; healing DOES affect PCs). saveAbility is the full word
  (strength…charisma), the effect name param is 'label', the target list is
  'targetNames' and is a real array. Emanations (move with caster) → token aura.
  Fixed areas (Web/Cloudkill/Fireball footprint) → create_zone.
- 2+ token writes → batch_exec, not N single calls. All dice → roll_dice (Roll20
  roller), never computed in-head. A result rolled OUTSIDE Roll20 (D&D Beyond, a
  companion app) is posted with post_roll_as_character — never re-rolled.
- Initiative: npcOnly:true (PC init read-only); never wholesale setTurnOrder.
  Explicit per-combatant bonus/HP goes in entries:[{match,bonus?,hp?}].
- There are NO tactics tools and NO D&D Beyond tools in this server. Calling
  plan_tactics / plan_all_tactics / any ddb_* / full_sync_character /
  sync_character_state / screenshot_roll20 / deploy_mod_script is a hallucination
  and scores 1 on D1. set_mob_plan only STORES a plan the caller already made.
- Player-visible text must contain NO numbers (no remaining/total HP, no totals);
  damage/effects in words only. The per-turn GM report MAY contain exact numbers.
- Never auto-advance the turn (advance_turn only on explicit DM say-so). After
  switch_campaign, wait for confirmation before any other tool.

Output JSON:
{ "D1_tool_selection": {score, evidence},
  "D2_params_hp_routing": {score, evidence},
  "D3_model_choice": {score, evidence_or_NA},
  "D4_narration_discipline": {score, evidence},
  "D5_safety_procedure": {score, evidence},
  "D6_stt_correction": {score, evidence_or_NA},
  "overall": {score_0_30, top_fix} }

<<DM NARRATION>>
<<ASSISTANT REPORT>>
<<TOOL CALLS>>
<<PLAYER-VISIBLE TEXT>>
<<MODEL/TIER>>
```

### 10.4 Scoring sheet

| Turn / phase | D1 | D2 | D3 | D4 | D5 | D6 | /30 | Top fix |
|---|---|---|---|---|---|---|---|---|
| 5A single-target |  |  | N/A |  |  | N/A |  |  |
| 5C fireball/saves |  |  | N/A |  |  | N/A |  |  |
| 5D emanation |  |  | N/A |  |  | N/A |  |  |
| 5E zones |  |  | N/A |  |  | N/A |  |  |
| 5F death / dying |  |  | N/A |  |  | N/A |  |  |
| 7B gem voice turn |  |  | ★ |  |  |  |  |  |

> **Pass bar:** every safety dimension (D2, D5) ≥ 4 on every turn; D1/D3/D4 mean
> ≥ 4 across the session. A single D2/D5 failure (true-PC bar written, auto-advance,
> wholesale turn-order write, `kill_token` on a downed PC) is a **hard fail**
> regardless of other scores. Score dimensions marked N/A out of the total.

---

## Appendix — quick reference

- **Servers:** `roll20-dm` (HTTP, combat) `npm run serve`; `roll20-dm-maps`
  (stdio, map prep) via `.mcp.json`. The gem lives in the separate **dm-whisper**
  repo (a local `voice-hud/` here is a pre-split leftover).
- **Mod redeploy after editing `mod-scripts/ai-relay.js`:** **paste it into the
  campaign's API console by hand**, per campaign, and confirm the console prints
  `[GM_AI_Bridge] Relay script loaded (v2.7.0)`. Verify the LOAD, not the save.
  (`npm run release:mod` and `deploy_mod_script` are deleted.)
- **Transport:** RT (Firebase RTDB) only. No browser, no Playwright, no chromium step.
- **Credentials:** furnished, never minted — the server reads
  `roll20-rt-token.json` (campaign-scoped, ~50 min) and `roll20-upload-cache.json`
  (8 h) from the data dir (`ROLL20_DATA_DIR`, default `./data`) and raises
  `Roll20TokenUnavailableError` / `Roll20UploadCredentialError` when they're missing
  or stale. The gem harvests them.
- **`ANTHROPIC_API_KEY`:** maps suite only (`analyze_battlemap`). The combat server
  reaches no Anthropic code.
- **Wall color:** always pass `#0044FF` (default is yellow). Openings: doors
  `#FF0000`, windows `#00FFFF` (cyan), secret `#9932CC`.
- **HP routing (three-way):** true PC → `adjustPcHp` (tracked, never bar1);
  NPC → bar1; **sidekick** (player-controlled + registry override) → bar1, and dies
  like an NPC. Set with `set_token_class`.
- **Death:** `kill_token` (NPC/sidekick, or a DM-declared PC death) — one call, marker
  + map layer, not an HP edit. A true PC at 0 HP → `set_pc_dying`.
- **AoE vs emanation vs zone:** `resolve_aoe` for the AoE event; **aura** for
  emanations (move with caster); **`create_zone`** for fixed areas.
- **SSE `/events` emits:** `combat-update`, `mob-plan` (`plan: null` = cleared),
  `inbox-item`, `sandbox-status`, `map-ping`, `chat-message`.
- **Gone (don't call):** all `ddb_*`, `full_sync_character`, `sync_character_state`,
  `plan_tactics`, `plan_all_tactics`, `record_tactic_outcome`, `get_tactic_memory`,
  `clear_tactic_memory`, `screenshot_roll20`, `deploy_mod_script`, `read_mod_console`,
  `dump_mod_page_structure`, `reconnect_browser`, `debug_turn_order`.
- **Never:** wholesale `setTurnOrder`, roll PC initiative, auto-advance the turn,
  put numbers in player-visible chat, chain a tool right after `switch_campaign`.
- **Logs (post-hoc review):** `hud.log` (JSONL, under `DMW_DATA_DIR`) — all gem log
  lines incl. `[ptt]` PTT down/up/force-release, tool calls, confirms. STT corpus:
  `ab-clips/*.{wav,draft.txt}` when `DMW_SAVE_CLIPS=1`. Paths and scripts are
  dm-whisper's — check that repo.
