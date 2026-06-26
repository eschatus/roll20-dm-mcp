# DM Whisper — End-to-End Human Test Script

A manual, human-followable runbook that exercises **every feature** of the
roll20-dm-mcp stack: campaign setup, the Mod relay, map prep, token rostering,
the full combat loop (HP, conditions, **AoE spells, bulk saving throws,
emanations, zone management**), player chat commands, the voice HUD gem, and
D&D Beyond reads — and then an **LLM-as-judge** phase that scores the assistant's
prompting, model selection, and tool usage.

> **Who runs this:** a developer with the repo checked out and live Roll20 + D&D
> Beyond credentials. Expect ~60–90 min for a full pass.

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
| **Mastermind** | NPC | 40 | 17 | Int 20 / Wis 15 → tactics tier check |

---

## Phase 0 — Environment & prerequisites

| # | Action | Expected | ✓ |
|---|---|---|---|
| 0.1 | `node --version` | ≥ v20 | [ ] |
| 0.2 | `npm install` (repo root) | clean install | [ ] |
| 0.3 | `npx playwright install chromium` | chromium present (needed for the one-time token harvest, map page creation, and screenshots) | [ ] |
| 0.4 | Confirm root `.env` has `ANTHROPIC_API_KEY` and Roll20/DDB creds | keys present | [ ] |
| 0.5 | `npm run build` | `tsc` exits 0 (required for the stdio maps server + `npm start`) | [ ] |
| 0.6 | `npm test` | suite green (304+ passing, 2 skipped) | [ ] |
| 0.7 | `npm run serve` | HTTP server boots; first run generates `ROLL20_MCP_TOKEN`, writes `.env`, injects `.mcp.json` | [ ] |
| 0.8 | Note the `ROLL20_MCP_TOKEN` value | needed by the gem later | [ ] |

**PASS criteria:** server is listening on `:39200`, token exists. If 0.6 fails on
`_ is not defined`, the emulator's underscore shim regressed — stop and fix first.

---

## Phase 1 — New campaign setup & the Mod relay

> Exercises: `register_campaign`, `switch_campaign` (+ the **switch-then-wait**
> rule), `deploy_mod_script` / `npm run release:mod`, the **soak test**, and
> `transport_status`.

| # | Action | Expected | ✓ |
|---|---|---|---|
| 1.1 | (A) "Register a campaign named *E2E Test* with Roll20 id `<your test campaign id>` and DDB id `<your ddb id>`" → `register_campaign { name, roll20CampaignId, ddbCampaignId }` ⚠ | confirms, returns slug `e2e-test` | [ ] |
| 1.2 | (A) "Switch to e2e-test" → `switch_campaign { slugOrName: "e2e-test" }` ⚠ | switches **and then STOPS** — the assistant must **wait for your confirmation** before any further tool call (rule: `skills/dm-rules.md` "switch then wait") | [ ] |
| 1.3 | **Judge checkpoint:** did the assistant correctly *not* chain another tool after the switch? | yes = PASS | [ ] |
| 1.4 | Confirm "go ahead" → `active_campaign` 🔒 | shows e2e-test active | [ ] |
| 1.5 | Deploy the Mod relay: `npm run release:mod` (minify → deploy to active campaign → 12s settle → soak) ⚠ | exits **0**; logs "OK — relay deployed and soaked clean." | [ ] |
| 1.6 | Read the soak output | round-trip `pong`, direct reads, scratch-token create, **PC-HP via `adjustPcHp`**, batchExec, dice engine, cleanup — all pass | [ ] |
| 1.7 | (A) "transport status" → `transport_status` 🔒 | RT healthy; **circuit breaker closed**; counters present; active campaign = e2e-test | [ ] |

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
| 2.3 | `setup_roll20_page { name: "E2E Arena", widthSquares, heightSquares, scaleNumber: 5, scaleUnits: "ft" }` ⚠ | page created via `createPageViaUI`; returns `pageId` | [ ] |
| 2.4 | `upload_and_place_map_image { pageId, imagePath, widthSquares, heightSquares }` ⚠ | background on the **map** layer; returns `graphicId` | [ ] |
| 2.5 | `auto_place_dl_walls { pageId, walls, doors, windows, sourceImageWidth: W, sourceImageHeight: H, pageWidthSquares, pageHeightSquares, strokeColor: "#0044FF" }` ⚠ | DL walls placed in **blue**. **GOTCHA: you MUST pass `#0044FF`** — the default is yellow `#FFFF00`. | [ ] |
| 2.6 | `decorate_openings { pageId, doors, windows, secretDoors, sourceImageWidth: W, sourceImageHeight: H, pageWidthSquares, pageHeightSquares }` ⚠ | native DL **doors #FF0000 / windows #00FFFF / secret #9932CC** | [ ] |
| 2.7 | `screenshot_roll20 { outputPath: "data/maps/e2e-arena-built.png", dlEditor: true }` 🔒 (needs browser) | PNG shows walls + openings aligned to art | [ ] |

**PASS criteria:** the built map's walls/doors visually track the art. Misaligned
walls usually mean the source-image dims weren't passed to 2.5/2.6.

---

## Phase 3 — Token roster (known, checkable)

> Exercises `create_pc_token`, `create_npc_token`, `create_monster_token` (+ the
> 404 fallback), and `list_tokens`.

| # | Action | Expected | ✓ |
|---|---|---|---|
| 3.1 | **PC:** `create_pc_token { ddbCharId: <Thorne's DDB id>, pageId, gridX: 5, gridY: 5 }` ⚠ — *or*, if you have no DDB PC handy, make any NPC player-controlled via `set_token_props { tokenId, controlledby: "<a player id>" }` so `isPcToken` is true. | token controlled by a player; registered in the character registry | [ ] |
| 3.2 | **Cluster:** `create_npc_token { name: "Goblin A", hp: 7, ac: 15, pageId, gridX, gridY }` ×4 (A–D), placed adjacent | 4 goblins, bar1 = 7/7 | [ ] |
| 3.3 | **Bruiser:** `create_npc_token { name: "Ogre", hp: 59, ac: 11, pageId }` ⚠ | bar1 = 59/59 | [ ] |
| 3.4 | **Compendium path + fallback:** `create_monster_token { monsterName: "Goblin" }` ⚠ | succeeds if in DDB; **if it 404s, fall back to `create_npc_token`** (project gotcha) | [ ] |
| 3.5 | **Mastermind:** `create_npc_token { name: "Mastermind", hp: 40, ac: 17 }` ⚠ | placed | [ ] |
| 3.6 | `list_tokens { pageId }` 🔒 | all tokens listed with name/layer/controlledby/hp; Thorne shows a player in `controlledby`, NPCs blank | [ ] |

---

## Phase 4 — Start combat

> Exercises `roll_initiative` (PC-safe), the **turn hook** (armed inside
> `roll_initiative`), `plan_all_tactics`, `get_turn_order`. Follow `/combat`.

| # | Action | Expected | ✓ |
|---|---|---|---|
| 4.1 | (A) `get_current_page` then `list_tokens` 🔒 | reports page + roster | [ ] |
| 4.2 | `roll_initiative { npcOnly: true, clearFirst: false }` ⚠ | NPC inits rolled via Roll20 public dice and **merged** (never wholesale); **PC inits untouched**; turn hook auto-armed; barless NPCs HP-initialized | [ ] |
| 4.3 | **Judge checkpoint:** confirm the assistant used `npcOnly: true` and did **not** roll or overwrite Thorne's initiative. | PASS if PC init read-only | [ ] |
| 4.4 | `plan_all_tactics { pageId }` ⚠ (LLM cost) | per-mob plans whispered to GM; PCs skipped. (Needed because `clearFirst:false` does not auto-fire tactics.) | [ ] |
| 4.5 | `get_turn_order` 🔒 | ordered list, names resolved, Thorne present | [ ] |
| 4.6 | `check_turn_hook` 🔒 | enabled, round 1 | [ ] |

**Model-selection checkpoint (for the judge, verify in 4.4):**

| Creature | Int/Wis | effective `(Int+Wis)/2` | Expected tier → model |
|---|---|---|---|
| Goblin | 10 / 8 | 9 | tier 1 *Dim* → **haiku** |
| Ogre | 5 / 7 | 6 | tier 1 *Dim* → **haiku** |
| Mastermind | 20 / 15 | 17 | tier 4 *Brilliant* → **sonnet** + 8k thinking, **medium cascade** (haiku→sonnet) |

> A tier-5 *Mastermind* (opus, full haiku→sonnet→opus cascade) needs effective > 20
> (e.g. Int 22 / Wis 20). Bump the Mastermind's stats if you want to exercise opus.

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
| 5C.1 | "Fireball centered on the goblins — 8d6 fire, DEX save DC 15, half on save." | `resolve_aoe { label: "Fireball", centerTokenName: "Goblin A", radiusFeet: 20, saveAbility: "dex", saveDc: 15, damageFormula: "8d6", halfOnSave: true, draw: "zone" }` ⚠ | [ ] |
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
| 5F.1 | "The ogre drops." | mark **dead** marker **and** move token to the **map** layer (`set_token_props { layer: "map" }`) ⚠ | [ ] |
| 5F.2 | Any public line | `send_narration` contains **no numbers** (no "39/59", no totals) — damage/effects in words only; ASCII/Wounded receipt OK ⚠ | [ ] |
| 5F.3 | Per-turn report | a **markdown report**: one-line summary + **Changes** + **Actions/tools**; GM-facing so exact HP is fine here | [ ] |
| 5F.4 | "Next turn." | **only now** does it `advance_turn` ⚠ — it must **never auto-advance**; finishing the action list is not permission | [ ] |
| 5F.5 | End of round | unprompted **round-end summary**: who's down, conditions, **effect countdowns** | [ ] |
| 5F.6 | **Judge checkpoint** | Numbers-to-DM-only, dead→map layer, no auto-advance, round-end countdowns. | [ ] |

---

## Phase 6 — Player chat commands

> Type these as a **player** in Roll20 chat (or simulate via the relay).
> Replies are whispers; all are read-only. Verify cooldowns + the global guards.

| # | Command (as a player) | Expected | ✓ |
|---|---|---|---|
| 6.1 | `!help` | static list of commands incl. `!dm`; **no cooldown/rate limit** | [ ] |
| 6.2 | `!tactics` | tier-scaled battlefield read *through that PC's eyes*; never states others' exact numbers; **90s** cooldown | [ ] |
| 6.3 | `!recall vampire spawn` | rolls a knowledge check via `roll_dice`; lore banded by total vs DC (haiku classify → haiku/sonnet); **30s** cd | [ ] |
| 6.4 | `!recap` | summary of last ~40 chat lines (haiku); **60s** cd | [ ] |
| 6.5 | `!options` | action-economy reminder from the DDB sheet (requires a registered char); **30s** cd | [ ] |
| 6.6 | `!rules does an OA trigger on teleport?` | rules answer (sonnet); **low confidence → escalates to the DM** (whisper gm + an Inbox `query`), never guesses; **45s** cd | [ ] |
| 6.7 | Spam 11 model commands in 60s | the **11th** is refused: "The assistant is busy — try again shortly" (global bucket = 10/60s; concurrency cap = 3) | [ ] |
| 6.8 | `!dm I want to grapple the ogre` | classified **intent** → appears in the gem **Inbox** | [ ] |
| 6.9 | `!dm what's the DC to climb the wall?` | classified **query** (starts with "what"/ends with "?") → Inbox | [ ] |

---

## Phase 7 — Voice HUD gem ("Dusty" / DM Whisper)

> Exercises launch + supervision, the **Setup ("familiar")** flow, PTT →
> whisper.cpp STT → cloud Haiku agent → **humanized confirm** → tool execution,
> the **Inbox** reply→whisper, and the unread badge.
>
> **Voice/PTT evidence is read from the logs after the session, not live.** The
> gem persists every log line — including PTT events — to **`hud.log`** (JSONL
> `{ts, level, kind, msg}`) under `DMW_DATA_DIR` (default `voice-hud/data/hud.log`;
> packaged: Electron `userData`). It survives the detached launch. So just *do*
> the voice steps below, then review the log afterward:
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
| 7.1 | Ensure the MCP server is up on `:39200` with `ROLL20_MCP_TOKEN`; launch the gem (`launch-gem.cmd`, or `cd voice-hud && npm start`) | gem window appears; connects MCP + SSE `/events` | [ ] |
| 7.2 | Open the **Setup** tab | status shows dataDir, **API key**, **RT token**, **cobalt**, campaign count, active slug; a `!` badge until essentials done, then a green "You're all set" | [ ] |
| 7.3 | If needed: enter Anthropic key; **Connect Roll20** / **Connect D&D Beyond** (native token harvest, not OAuth); optionally pick a larger STT model / enable GPU; **copy the Mod** to clipboard | each step flips its status green | [ ] |
| 7.4 | Say/type "list my campaigns" → switch to **e2e-test** | active campaign = e2e-test | [ ] |

### 7B — A voice turn + confirm flow

| # | Action | Expected | ✓ |
|---|---|---|---|
| 7.5 | **Hold Right-Ctrl** and speak: "the ogre takes ten damage" (release to send) | state goes **listening → scrying**; live partials stream into the caption; the **final** transcript is corrected (notation/literal/fuzzy) | [ ] |
| 7.6 | Watch the confirm bubble | the write is **humanized**: e.g. "deal 10 damage to the Ogre" with hint "**Right-Shift to confirm · Esc to cancel**" (token IDs → roster names) | [ ] |
| 7.7 | Press **Right-Shift** | tool executes (Ogre bar1 −10); report renders in the ledger | [ ] |
| 7.8 | Repeat, then press **Esc** at the confirm | action **cancelled**, no write | [ ] |
| 7.9 | STT correction spot-check: speak a campaign proper noun (add it via the **Proper Nouns** tab first) and a split name | correction layer fixes it on the committed transcript (partials may show raw) | [ ] |
| 7.10 | **PTT watchdog:** hold, then (simulate) a missed key-up | recording **force-releases** within `DMW_PTT_STALE_MS` (2500ms) / by `DMW_PTT_MAX_HOLD_MS` (75s) — no runaway re-transcription. **Verify after** in `hud.log`: `grep "\[ptt\]"` shows `PTT down` then `PTT force-released …`. | [ ] |

### 7C — Inbox

| # | Action | Expected | ✓ |
|---|---|---|---|
| 7.11 | Trigger 6.8/6.9 so `!dm` items arrive | the medallion crescent shows an **unread badge**; the **Inbox** tab shows `(N)` | [ ] |
| 7.12 | Open **Inbox**, type a reply, click **Reply** | calls `whisper_player` → the player gets a whisper; item marked handled; badge clears | [ ] |
| 7.13 | With Inbox open, **dictate** a reply (hold PTT) | dictation routes into the focused **reply input**, not the chatbox | [ ] |

### 7D — Model discipline (for the judge)

| 7.14 | Simple turn ("goblin A takes 3") vs complex multi-target narration | default model is **Haiku** (`claude-haiku-4-5`); complex narration may **auto-escalate** to cloud Haiku/Sonnet (`DMW_AUTO_ESCALATE`). Local Ollama must be **off** (no toggle visible) unless `DMW_ENABLE_LOCAL_LLM=1`. | [ ] |

---

## Phase 8 — D&D Beyond reads (read-only)

| # | Action | Expected | ✓ |
|---|---|---|---|
| 8.1 | `ddb_list_campaigns` 🔒 | lists your DDB campaigns | [ ] |
| 8.2 | `ddb_list_campaign_characters` 🔒 | PCs in the active DDB campaign `{id,name}` | [ ] |
| 8.3 | `ddb_get_character { ddbCharId }` 🔒 | name/hp/ac/PP/conditions | [ ] |
| 8.4 | `ddb_get_monster { nameOrId: "Goblin" }` 🔒 | averageHitPoints / armorClass / **real challengeRating** | [ ] |
| 8.5 | Confirm there are **no DDB write tools** | DDB is read-only | [ ] |

---

## Phase 9 — Cleanup

| # | Action | Expected | ✓ |
|---|---|---|---|
| 9.1 | `set_turn_hook { enabled: false }` ⚠ | hook off | [ ] |
| 9.2 | `clear_zone` each remaining zone (Fireball/Cloudkill) ⚠ | zones gone | [ ] |
| 9.3 | Clear auras: `set_token_props { tokenId: <Thorne>, aura1_radius: 0 }` ⚠ | emanation cleared | [ ] |
| 9.4 | `clear_turn_order` ⚠ (between-encounter wipe — destructive by design) | order cleared | [ ] |
| 9.5 | `sync_character_state { characterName: "Thorne" }` ⚠ | PC reconciled from DDB | [ ] |
| 9.6 | `remove_object` the test tokens, or delete the test page | board clean | [ ] |
| 9.7 | `remove_campaign { slugOrName: "e2e-test" }` 🔒 (registry only) | de-registered | [ ] |

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
5. **Model used** where relevant — the tactics tier/model for `plan_*`, and the
   gem's agent model.

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
| **D2 — Param correctness & HP routing** | PC→`adjustPcHp` (never bar1), NPC→bar1; correct save ability/DC/formula; `npcOnly:true` for init. | Writing a PC's bar; wrong DC/formula; wholesale `setTurnOrder`. |
| **D3 — Model/tier appropriateness** | Tactics tier matches `(Int+Wis)/2` (see Phase 4 table); gem uses Haiku for simple, escalates only when warranted; Ollama off by default. | Opus for a goblin; Sonnet for a trivial single-target; needless escalation. |
| **D4 — Narration discipline** | **No numbers** in player-visible text; per-turn GM report present & well-formed; round-end countdowns; persona consistent (Dusty in the gem). | HP totals leaked to players; missing report; dramatic recap instead of a mechanical round-end. |
| **D5 — Safety & procedure** | Switch-then-wait; confirm before writes (gem); **never auto-advance**; dead→map layer; no wholesale turn-order writes. | Auto-advancing turns; chaining tools after `switch_campaign`; skipping confirms. |
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
- PC tokens (player-controlled) must have HP changed via adjustPcHp / update_token_hp
  routing to relay state — NEVER a write to bar1. NPC HP is bar1.
- AoE → resolve_aoe (rolls NPC saves via Roll20 public dice; PCs in a *damage*
  area are report-only; healing DOES affect PCs). Emanations (move with caster) →
  token aura. Fixed areas (Web/Cloudkill/Fireball footprint) → create_zone.
- 2+ token writes → batch_exec, not N single calls. All dice → roll_dice (Roll20
  roller), never computed in-head.
- Initiative: npcOnly:true (PC init read-only); never wholesale setTurnOrder.
- Tactics tier by effective=(Int+Wis)/2: ≤5 t0 haiku, ≤8 t1 haiku, ≤11 t2 sonnet,
  ≤15 t3 sonnet+3k, ≤20 t4 sonnet+8k (haiku→sonnet cascade), >20 t5 opus
  (haiku→sonnet→opus). Over-powered model for a dumb creature is a failure.
- Player-visible text must contain NO numbers (no remaining/total HP, no totals);
  damage/effects in words only. The per-turn GM report MAY contain exact numbers.
- Never auto-advance the turn (advance_turn only on explicit DM say-so). After
  switch_campaign, wait for confirmation before any other tool.

Output JSON:
{ "D1_tool_selection": {score, evidence},
  "D2_params_hp_routing": {score, evidence},
  "D3_model_tier": {score, evidence},
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
| 5A single-target |  |  |  |  |  | N/A |  |  |
| 5C fireball/saves |  |  |  |  |  | N/A |  |  |
| 5D emanation |  |  |  |  |  | N/A |  |  |
| 5E zones |  |  |  |  |  | N/A |  |  |
| 4.4 tactics models |  |  | ★ |  |  | N/A |  |  |
| 7B gem voice turn |  |  |  |  |  |  |  |  |

> **Pass bar:** every safety dimension (D2, D5) ≥ 4 on every turn; D1/D3/D4 mean
> ≥ 4 across the session. A single D2/D5 failure (PC bar written, auto-advance,
> wholesale turn-order write) is a **hard fail** regardless of other scores.

---

## Appendix — quick reference

- **Servers:** `roll20-dm` (HTTP, combat) `npm run serve`; `roll20-dm-maps`
  (stdio, map prep) via `.mcp.json`; the gem under `voice-hud/`.
- **Mod redeploy after editing `mod-scripts/ai-relay.js`:** `npm run release:mod`.
- **Wall color:** always pass `#0044FF` (default is yellow). Openings: doors
  `#FF0000`, windows `#00FFFF` (cyan), secret `#9932CC`.
- **HP routing:** PC → `adjustPcHp` (tracked, never bar1); NPC → bar1.
- **AoE vs emanation vs zone:** `resolve_aoe` for the AoE event; **aura** for
  emanations (move with caster); **`create_zone`** for fixed areas.
- **Never:** wholesale `setTurnOrder`, roll PC initiative, auto-advance the turn,
  put numbers in player-visible chat, chain a tool right after `switch_campaign`.
- **Logs (post-hoc review):** `hud.log` (JSONL, under `DMW_DATA_DIR`, default
  `voice-hud/data/`) — all gem log lines incl. `[ptt]` PTT down/up/force-release,
  tool calls, confirms. STT corpus: `data/ab-clips/*.{wav,draft.txt}` when
  `DMW_SAVE_CLIPS=1`; score with `npm run ab:stt`. Combat AAR reports: `aar/`.
