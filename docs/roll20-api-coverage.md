# Roll20 Mod (API) Coverage Map

**Purpose:** the authoritative reference for *what the Roll20 Mod (API) can do* vs. *what this
project currently exposes*, so future work doesn't keep rediscovering coverage gaps. When a
capability is marked **API-reachable but not exposed**, the fix is a new relay action (cheap).
When it's marked **browser-only**, the API genuinely can't do it — and as of v2.0.0 that means it
is **out of scope here**, not "bridged with Playwright".

> **v2.0.0 rule: no browser anywhere.** `playwright` is not a dependency and neither server can
> open one. *If it cannot be done without a browser, it is not an MCP tool here.* The whole
> Playwright bridge (art upload via DOM, `createPageViaUI`, screenshots, current-page reads,
> campaign-switch navigation, `debug_turn_order`, the Mod-console tools) is gone — see §3's
> "formerly browser-bridged" table for where each capability went. **RT (Firebase RTDB) is the
> only transport.**

> **Doc sources — and they ARE machine-readable.** The reference lives at help.roll20.net
> (Zendesk): [Function Documentation](https://help.roll20.net/hc/en-us/articles/360037772833-Mod-Scripts-Function-Documentation),
> [Objects](https://help.roll20.net/hc/en-us/articles/360037772793-Mod-Scripts-Objects),
> [Change Log](https://help.roll20.net/hc/en-us/articles/360037772613-Change-Log).
> This doc used to claim both doc hosts "hard-block automated fetching (HTTP 403)". That is
> **false and cost us a rebuild-from-memory baseline.** What 403s is the agent `WebFetch` tool's
> user agent. `curl` with a browser UA gets a 200 and the whole article:
>
> ```
> curl -sSL -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' <url>
> ```
>
> Read the page before trusting anything below it — §2 is transcribed from the live articles, but
> Roll20 ships changes weekly and the Objects page visibly lags its own change log.

**Mod Script Sandbox v1.0 vs v1.5 — read this before anything else.** On **2026-09-02** Roll20 made
**v1.5 the default** for every game that had never explicitly picked a version (the old
"Experimental"/"Default" labels were renamed to 1.5/1.0 in the same release). The two are a
documented behavioral fork, they are **per-campaign** exactly like a relay deploy, and a campaign
can be moved back to 1.0 by hand. `ACTIONS["ping"]` echoes `Campaign().sandboxVersion` /
`nodeVersion` / `sheetName` and a `beacon` flag as of relay **2.6.2**, and `transport_status`
surfaces them under `sandbox` — that is how you find out which one a campaign is on. A `sandbox` of
`null` there means the *relay* is older than 2.6.2, not that the sandbox is old.

Last analyzed: **2026-09-08** (docs re-read live; repo v2.0.3). Relay version string: `2.6.2`
(reported by the `ping` action, and echoed in the Mod console's load banner). **Deploying the relay is a manual, per-campaign
paste** — `deploy_mod_script` and `npm run release:mod` are deleted; verify the *load* banner
(`[GM_AI_Bridge] Relay script loaded (v2.6.2)`), not the save.

---

## 1. Architecture recap (where capability comes from)

```
Claude → MCP tool (TS) → roll20.relayCommand({action,...})
                              │
                              ├─ tryDirectRead / tryDirectWrite (roll20-rt.ts) — served straight
                              │  off the RTDB socket, no Mod round-trip. Falls through on anything
                              │  it can't handle (or with __forceMod), so the Mod stays authoritative.
                              ▼
                       !ai-relay {JSON} pushed over the campaign's Firebase RTDB chat node
                              ▼
                       ai-relay.js (Mod sandbox)  →  Roll20 object model (createObj/findObjs/get/set)
                              ▲
                       AIBRIDGE_RESULT whispered back — read over an RTDB child listener (~50ms)
```

**Two layers of "can do":**
1. **Relay actions** (73 action handlers in the `ACTIONS` dispatch map in `ai-relay.js`, plus `batchExec` sub-actions) — the real Roll20 API surface this project uses.
2. **Direct RTDB paths** (`tryDirectRead` / `tryDirectWrite` in `src/bridge/roll20-rt.ts`) — a faster
   route to a *subset* of the same actions off the socket, plus the two things the sandbox genuinely
   can't do (`rtCreatePage`, and art upload via a furnished-credential multipart POST).

> The third layer this doc used to have — a **DDB bridge** — is gone. D&D Beyond left this repo
> entirely; [beyond-mcp](https://github.com/eschatus/beyond-mcp) owns it and serves the same tool
> names. See §3's DDB note.

**Skills add nothing here.** `/combat`, `/round`, `skills/dm-combat.md`, `skills/dm-rules.md`,
`skills/dm-map-setup.md` are orchestration prompts; they can only call tools that already exist.
Coverage = relay + direct RTDB.

---

## 2. Roll20 Mod API surface (the baseline)

### Object types
`createObj(type, …)` **can create** exactly these (transcribed live 2026-09-08):
`graphic`, `text`, `path`, `pathv2`, `character`, `ability`, `attribute`, `handout`,
`rollabletable`, `tableitem`, `macro`, `card`, `deck`, `custfx`, `window`, `door`, `pin`
— plus `pageFolder` on **sandbox v1.5 only**.

`pathv2` (DL barriers/walls), `door` and `window` are now first-class in that list, so the
legacy-`path` fallback in the relay's `createWalls` is dead code (and it hardcodes a yellow stroke
against the project's blue-wall convention — #207).

**`pin` is a new object type this project does not use at all** (#203). Map pins: `shape`
(teardrop/circle/diamond/square), a built-in `icon` set or a `pinImage`, `title`/`notes`/`gmNotes`,
`link` + `linkType:"handout"`, and per-audience visibility (`visibleTo`, `tooltipVisibleTo`,
`gmNotesVisibleTo`, …). Note the camelCase — `gmNotes` on a pin, not `gmnotes` as everywhere else.

**Read/queryable but still NOT createObj-creatable:** `page`, `campaign`, `player`, `hand`,
`jukeboxtrack`. `page`'s absence is what justifies `rtCreatePage` (#178) — the RTDB write is the
only browserless way to make one, and that is confirmed still true.

### Universal functions
`createObj` · `getObj(type,id)` · `findObjs(attrs,opts)` · `filterObjs(fn)` · `getAllObjs()` ·
`getAttrByName(charId,name,"current"|"max")` · `Campaign()` / `getCampaign()`.
Object methods: `.get(prop)`, `.set(prop|obj)`, `.setWithWorker(...)`, `.remove()`, `.id`.

### Global functions
`on(event,cb)` · `log()` · `sendChat(speaker,input,cb,opts)` · `playerIsGM(pid)` ·
`spawnFx(x,y,type,pageid)` · `spawnFxBetweenPoints(p1,p2,type,pageid)` · `spawnFxWithDefinition()` ·
`sendPing(left,top,pageid,playerid?,moveAll?,visibleTo?)` · `playJukeboxPlaylist()` /
`stopJukeboxPlaylist()` · `toFront(obj)` / `toBack(obj)` · `randomInteger(max)` ·
`getActiveCharacterId()` · `setDefaultTokenForCharacter(char,token)` · `onSheetWorkerCompleted()`.
Persistent storage: the global **`state`** object (survives sandbox restarts).

**Documented but unused here (both sandbox versions):**
- **`setAttrs(charId, {name: value})`** — writes attributes and **defaults to `setWithWorker`**
  (`options.silent` opts out), handles `_max` suffixes and `repeating_…_$n` names. Sheet workers
  firing is exactly what the `rollbase` scaffolding and the `<ability>_mod` derivation in
  `createCharacter` exist to work around. Untested against a live sheet; #206.
- `getSheetItem` / `setSheetItem` (async, Promise) — the sheet-aware attribute carriers. On v1.0
  they wrap attributes; on v1.5 they also reach Beacon computed properties and `user.*` attrs.
- `getSheetDefaultValue(name, valtype?)` — the sheet's default for a field, not the live value.
- `findObjs` options now include **`tagMatch: 'all' | 'any' | 'only'`** beside `caseInsensitive`
  and `startsWith`. (#209 covers this and the rest of the small unused surface.)
- Card/deck helpers: `shuffleDeck`, `cardInfo`, `recallCards`, `dealCardsToTurn`, `drawCard`,
  `pickUpCard`, `takeCardFromPlayer`, `playCardToTable`, `giveCardToPlayer`.

**Sandbox v1.5 only:**
- `getComputed` / `setComputed` / `performAction` — Beacon sheet computed properties and sheet
  actions. Enumerate them with `Campaign().computedSummary` / `actionSummary`.
- `toAbove(obj, target)` / `toBelow(obj, target)` — precise layer ordering; `toFront`/`toBack` are
  also "substantially faster" here, and graphics/paths/text gain `.toFront()` / `.toBack()` methods.
- `spawnFxBetweenPoints` beam types point at the end point (an angle bug is fixed).
- `log` error messages carry a context object; the Apr 2026 server release added per-script
  callstacks with script name + line and attributed "Possible Infinite Loop Detected" reports.
- Graphic `currentSide` — setting it auto-updates `imgsrc` for rollable tokens.

### Campaign() direct properties (NOT behind `.get()`)
`sandboxVersion` (`"1.0"`/`"1.5"`) · `nodeVersion` — both sandboxes.
`sheetName` · `computedSummary` · `actionSummary` — v1.5 only.

**Beacon sheets are a live hazard for the attribute path.** A Beacon ("advanced") sheet keeps
character data in computed properties, so `findObjs({_type:"attribute"})` cannot see it and
`createObj("attribute")` cannot reach it — the object is created, and the sheet never reads it. As
of relay 2.6.2 `setCharacterAttributes` refuses that write and reports it under `failed` with a
reason, rather than reporting `created` for a write that did nothing
(`test/sandbox-handshake.test.ts`). Full read/write support via `setComputed`/`setSheetItem` is
#205 — both are async, which the relay's action handlers have a pattern for (`rollDice`)
but have never needed for a write.

### Events (5 kinds)
`ready` · `change:<type>[:<prop>]` · `add:<type>` · `destroy:<type>` · `chat:message`.
Campaign specials: `change:campaign:turnorder`, `change:campaign:playerpageid`, etc.

### Campaign object
`turnorder` (JSON string), `initiativepage`, `playerpageid`, `playerspecificpages`,
`token_markers`, `_journalfolder`, `_jukeboxfolder`.

---

## 3. Relay action catalog → tool mapping

Server column: **combat** = `roll20-dm` (HTTP, `src/server-combat.ts`); **maps** = `roll20-dm-maps`
(stdio, `src/index-maps.ts`); **both** = registered in each. Tool names verified against the
`register*Tools` functions in `src/tools/*.ts` — not against any older list in this doc.

| Relay action | MCP tool(s) | Server | Notes |
|---|---|---|---|
| `getTokens` | list_tokens, get_map_graphics, get_turn_order (name resolution), roll_initiative, update_hp_many, resolve_aoe | both | page graphics (direct-read path) |
| `getSelection` | get_selection | combat | the DM's currently-selected tokens |
| `findTokensInRange` | find_tokens_in_range, resolve_aoe | combat | range query (aura/zone) |
| `getTokenById` | get_token, get/set_character_attribute, update_token_hp, kill_token, set_pc_dying, break_concentration, create_zone | both | full token read (direct-read path) |
| `setTokenProps` | set_token_props, kill_token (→ map layer), resolve_aoe (aura), create_pc_token, batch_exec | both | arbitrary `.set(props)`; direct-write path |
| `setTokenBar` | update_token_hp (NPC/sidekick), update_hp_many, roll_initiative (`entries[].hp` seed), resolve_aoe | combat | bar1 HP; direct-write path |
| `adjustPcHp` / `getPcHp` | update_token_hp, update_hp_many, resolve_aoe (all PC-routed writes) | combat | PC HP in a `%%PCHP={…}%%` block in the token's gmnotes, routed three ways by `classifyToken` (PC / NPC / sidekick). `getPcHp` has no tool of its own — it's the direct-read half of the same carrier. **Never write a PC's token bar.** |
| `setStatusMarker` | (internal) | — | single marker add/remove by tag; direct-write path |
| `setDefaultToken` | batch_exec (`set_default_token`) | combat | `setDefaultTokenForCharacter` (token↔sheet) |
| `toggleCondition` | set_token_marker, update_token_hp, kill_token, set_pc_dying, batch_exec | combat | resolves via 3-tier `resolveMarkerForState`; +`active_conditions`; direct-write path |
| `syncConditionsToToken` | update_token_hp (`replaceConditions`) | combat | replace all markers |
| `breakConcentration` | break_concentration, set_pc_dying (auto-cascade) | combat | removes the `Concentrating` marker, zeroes `aura1_radius`, and deletes zones whose duration is `{type:'concentration', caster}` (#134/#135) |
| `getTokenMarkers` | get_token_markers | combat | campaign custom markers |
| `getCustomStates` | list_custom_states | combat | tier-2 ad-hoc DM states + holders |
| `createToken` | create_pc_token, create_npc_token, create_monster_token | maps | **does not set `represents`** (so no sheet, and `ac` is reported-back-only, never stored) and takes no `controlledby` — `create_pc_token` sets it from its `controlledBy` param via a follow-up `setTokenProps`. All three take **caller-supplied stats**; none performs a lookup (#171). |
| `createGraphic` | place_map_image, upload_and_place_map_image, batch_import_maps | maps | map-layer image |
| `createPage` | — | — | **throws by design** — `createObj("page")` is unsupported in the sandbox. Page creation goes through `rtCreatePage` instead (see below). |
| `createPath` / `createPaths` | (internal) | — | legacy path |
| `createWalls` | auto_place_dl_walls, batch_import_maps | maps | creates native `pathv2` UDL barriers. Explicitly **not** direct-writable — Roll20's Firebase rules reject client writes to `pathv2/page/`, so this always goes through the Mod. |
| `createPolylines` | place_polyline_walls | maps | one multi-vertex path; Mod-only for the same reason |
| `createDLDoors` / `createDLWindows` | decorate_openings | maps | native UDL door/window (create only); direct-write path |
| `clearDLOpenings` | decorate_openings | maps | delete doors+windows; direct-write path |
| `getWalls` | get_walls | maps | reads `pathv2` barriers |
| `getPaths` | get_paths | maps | path + optional graphic (direct-read path) |
| `getDoors` | get_doors | maps | door/window read (direct-read path) |
| `clearLayer` | clear_layer | maps | path+graphic+pathv2+wall |
| `debugPage` | debug_page | maps | object-type census |
| `drawLayerTest` | draw_layer_test | maps | creates `path` |
| `runUVTT` | run_uvtt_import | maps | drives external UniversalVTTImporter mod |
| `listPages` | list_pages, get_current_page, setup_roll20_page, rename_roll20_page, batch_import_maps | both | page list (direct-read path) |
| `setPageProps` | setup_roll20_page, rename_roll20_page, batch_import_maps | maps | name/size/scale/grid subset |
| `setPageBackground` | (internal) | — | bg color only |
| `createZone`/`clearZone`/`listZones`/`findTokensInZone`/`processRoundEndZones` | create_zone, clear_zone, list_zones, process_round_end_zones, resolve_aoe | both | path on the map layer; **metadata lives in `state.GM_AI_Bridge.zones`, not on the path object** (path objects silently drop `name`/`gmnotes`/`fill_opacity` — #162/#164) |
| `removeObject` | remove_object | combat | graphic or path |
| `getTurnOrder`/`setTurnOrder`/`advanceTurn` | get_turn_order, clear_turn_order, advance_turn, update_turn_order, inject_round_marker, batch_exec | combat | `Campaign.turnorder`. **Never write `setTurnOrder` wholesale** — it erases player entries; only `clear_turn_order` does that deliberately. |
| `mergeTurnOrder` | roll_initiative, inject_round_marker, update_turn_order | combat | NPC-only upsert (preserves PC entries) |
| `rollInitiativeForTokens` | roll_initiative | combat | real dice + epithets; honours per-combatant `bonusOverrides` from `entries[].bonus` (#172) |
| `rollFormulas` | roll_dice, resolve_aoe | combat | real dice engine — all dice go through Roll20's roller, never a TS RNG |
| `setTurnHook`/`getTurnHookState` | set_turn_hook, check_turn_hook | combat | enables the `change:campaign:turnorder` hook; `roll_initiative` arms it itself |
| `sendNarration` | send_narration | combat | styled HTML to chat |
| `postChat` | post_roll_as_character | combat | renders an **already-rolled** result as a named roll card — never re-rolls. The bridging seam for dice rolled outside Roll20. |
| `whisperPlayer` | whisper_player | combat | `/w <name>` |
| `getRecentChat` | get_recent_chat | combat | from the in-memory chat buffer (direct-read path) |
| `getDmInbox`/`clearDmInbox` | get_dm_inbox, clear_dm_inbox | combat | `!dm` queue |
| `setMobPlan`/`getMobPlans`/`clearMobPlans` | set_mob_plan, get_mob_plans, clear_mob_plans | combat | **storage only.** The server no longer *plans* anything — the tactics tools (`plan_tactics`, `plan_all_tactics`, `record_tactic_outcome`, `get/clear_tactic_memory`) are removed and the gem owns tactical planning; this is just where it parks the resulting whisper cards. |
| `setCharacterAttributes`/`getCharacterAttributes` | set_character_attribute, get_character_attribute, read_character_attributes | combat | sheet attrs. **Never read a field containing literal `@{`/`[[`** (e.g. `rollbase`) — Roll20's chat pipeline live-evaluates it on echo. |
| `getRepeatingSection` | *(none)* | — | **read-only** (e.g. npcaction); row cap (maxRows default 60, `__truncated` flag); no field projection. Orphaned since tactics moved to the gem — the action still exists but no MCP tool calls it. |
| `editCharacter` | set_character_props | combat | edit top-level character fields (name/bio/avatar/controlledby/archived/inplayerjournals) |
| `batchExec` | batch_exec, update_hp_many, resolve_aoe, roll_initiative (HP seeding) | combat | runs N token actions in one relay round-trip |
| `getJournalFolder`/`setJournalFolder` | get_journal_folder, set_journal_folder | combat | journal folder tree read/write (direct paths) |
| `createHandout` | create_handout | combat | lore/player handout (name, notes, gmnotes) |
| `createCharacter` | create_character_stub | combat | `createObj('character')` stub; derives `<ability>_mod` from the raw score at creation (sheet workers never fire on API-created attrs) |
| `sendPing` | send_ping | maps | "look here" / pull player view to a spot |
| `spawnFx` / `spawnFxBetweenPoints` | spawn_fx, spawn_fx_between_points | maps | explosions, beams, spell nova |
| `toFront` / `toBack` | to_front, to_back | maps | z-order |
| `ping` | (health check) | — | reports relay version (2.6.2); drives the `EXPECTED_RELAY_VERSION` handshake surfaced by `transport_status` |
| **event** `chat:message` | (passive) | — | buffers chat, parses `!dm`. Player `!`-commands are **forwarded, not answered** — `forwardChat` broadcasts them as an SSE `chat-message`; the gem decides what to do. |
| **event** `change:campaign:turnorder` | (passive) | — | turn/round announcements |
| **event** `add:graphic` | (passive) | — | auto-rolls initiative for NPC tokens dropped during combat |
| **event** `ready` | (passive) | — | logs `state.GM_AI_Bridge` restoration on (re)deploy |

**Not in the relay at all:** `uploadArt` (`src/bridge/roll20.ts`) — a plain multipart POST to the
Roll20 art CDN using the **furnished** `roll20-upload-cache.json` credential. Backs `upload_image`
(combat) and `upload_and_place_map_image` / `batch_import_maps` (maps). No API path exists to upload
art, and this server never harvests the credential — a missing/stale one raises
`Roll20UploadCredentialError`. Likewise `rtCreatePage` (`src/bridge/roll20-rt.ts`) creates a page by
writing the RTDB directly, mirroring an existing page's schema.

### Formerly browser-bridged (Playwright) — where each one went
The Playwright bridge is **deleted**. Nothing in this table is a live capability; it is here so the
history isn't rediscovered.

| Old bridge function / tool | Status in v2.0.0 |
|---|---|
| `uploadArt` (DOM upload) | **Replaced, browserless** — direct multipart POST with a furnished credential (above). |
| `createPageViaUI` → setup_roll20_page | **Replaced, browserless** — `rtCreatePage` writes the page over RTDB. `createObj('page')` is still unsupported in the sandbox; the UI click never was the only way. |
| `takeScreenshot` → `screenshot_roll20` | **Removed.** Board vision by screenshot is gone from both servers. |
| `getCurrentPageId` → get_current_page | **Replaced, browserless** — `playerpageid` is read straight off the RTDB `campaign` node. |
| `debug_turn_order` | **Removed.** Use `get_turn_order`. |
| setcampaign navigation → switch_campaign | **Removed from the tool.** `switch_campaign` is now a registry-only operation; there is no page to navigate. |
| `deploy_mod_script`, `read_mod_console`, `dump_mod_page_structure`, `reconnect_browser` | **Removed.** Mod deploy is a human-attended paste into the campaign's API console (#175). |

### DDB bridge — removed (superseded)
The D&D Beyond bridge (`ddb_get_character`, `ddb_get_monster`, `ddb_list_campaigns`,
`ddb_list_campaign_characters`, `start_ddb_roll_pump`, `stop_ddb_roll_pump`, `ddb_roll_pump_status`),
along with `full_sync_character` and `sync_character_state`, is **gone from this repo** — as is every
DDB credential. [beyond-mcp](https://github.com/eschatus/beyond-mcp) owns D&D Beyond now and serves
**identical tool names**, so a DM runs both servers side by side.

Historical rationale, still worth knowing: DDB was read-only here before it left. All write paths
(`patchCharacter`, `applyCondition` / `removeCondition`, `ddb_update_hp`, and the DDB branches of
`apply_damage` / `heal_character`) had already been removed — DDB condition writes returned 405 and
HP writes were unreliable. Live HP and conditions are written exclusively to the Roll20 token;
**treat DDB as ground-truth read only.**

---

## 4. Coverage by capability area

Legend: ✅ exposed · 🟡 partial · ❌ API-reachable but **not exposed** (add a relay action) ·
⛔ **browser-only → out of scope** (v2.0.0: no browser, so this is a "won't do", not a "not yet").

### Strong (✅)
- **Tokens/graphics** — full CRUD; `setTokenProps` passes arbitrary props (bars, auras, tint, light, position, layer, gmnotes…).
- **HP & conditions** — token bars + status markers + char `active_conditions`; `batch_exec` for bulk; three-way PC / NPC / sidekick routing.
- **Initiative / turn order** — read, merge, advance, real-dice roll, auto announcements, round detection, epithets, per-combatant `entries[{match,bonus,hp}]` overrides.
- **Dice** — real Roll20 engine via inline rolls, plus `post_roll_as_character` for results rolled elsewhere.
- **Chat** — narration (styled), whisper, roll templates, `!ai-relay`/`!dm` parsing, and live table chat forwarded as SSE.
- **Sheet attributes** — read/write flat attrs; repeating-section **read**.
- **Paths/zones & DL walls** — create/read/clear; AoE zones with metadata in `state.GM_AI_Bridge.zones`.
- **DL doors/windows** — create/read/clear.
- **Pages** — list, configure (subset), and **create browserlessly** via `rtCreatePage`.
- **Art upload** — browserless multipart POST with a furnished credential.

### Partial (🟡)
- **`pathv2` DL barriers** — *read* via `getWalls`; `createWalls` now *creates* native `pathv2` (falling back to legacy `path` only if `pathv2` returns undefined). `drawLayerTest` deliberately creates `path`.
- **Door/window** — create/read/delete only; **no update** (open/close, lock, toggle secret) — all API-reachable.
- **Repeating sections** — read only; **no write** (no row-id generation / `generateRowID` helper); read has a row cap (maxRows default 60, `__truncated` flag) but no field projection. Since tactics moved to the gem, `getRepeatingSection` has **no MCP tool calling it** — the relay action is live but unreachable from a tool. (Writing rows is also the `rollbase` minefield — see `CLAUDE.md`.)
- **Page properties** — only name/size/scale/grid/bg; UDL lighting/fog/explorer-mode/grid-type/diagonal props not exposed (all API-reachable).
- **Token↔sheet linking** — `setDefaultTokenForCharacter` IS exposed (via `setDefaultToken` / `batch_exec`), but `createToken` still doesn't set `represents` on creation, so freshly-created tokens aren't sheet-bound until a default-token call runs.
- **Events** — `chat:message`, `change:campaign:turnorder`, `add:graphic`, and `ready` wired; `destroy:graphic`, `change:graphic:statusmarkers`, etc. still unused. On the server side these surface as the `/events` SSE stream: `combat-update`, `mob-plan` (`plan: null` = cleared), `inbox-item`, `sandbox-status`, `map-ping`, `chat-message`.

### API-reachable but NOT exposed (❌ — just add relay actions)
These are the "stop hitting the wall" items. None need the browser.
- **Audio** — `playJukeboxPlaylist` / `stopJukeboxPlaylist` + `jukeboxtrack` objects.
- **Move the player ribbon** — `Campaign().set('playerpageid', id)` ("bring players to this page"). *Not* browser-only.
- **Rollable tables** — `rollabletable`/`tableitem` (encounter/loot tables). Nothing exposed.
- **Cards/decks** — `deck`/`card`/`hand` (e.g. **Tarokka deck for Curse of Strahd**). Nothing exposed.
- **Abilities & macros** — `ability` (token actions) / `macro` CRUD. Nothing exposed.
- **Text objects** — floating map labels/annotations. Not created, read, or removed.
- **Character object** — `createCharacter` creates a stub; top-level field editing (name/bio/avatar/controlledby/archived/inplayerjournals) **is** exposed via `editCharacter` / `set_character_props`.
- **More on() hooks** — `destroy:graphic` (auto-detect token deaths), `change:graphic:statusmarkers`, etc.
- **Sheet-level monster stats** — with the DDB bridge gone (§3), nothing in this repo *looks up* a
  creature. `create_npc_token` / `create_monster_token` take caller-supplied HP/AC and don't even
  store AC (no `represents`, so no sheet to hold it). Closing the loop means either creation-time
  `represents` binding (below) or resolving stats from beyond-mcp before the call.

### Shipped since this doc's first draft (✅ — no longer gaps)
- **Visual FX** — `spawnFx` / `spawnFxBetweenPoints` → `spawn_fx`, `spawn_fx_between_points`.
- **Pings** — `sendPing` → `send_ping`.
- **Z-order** — `toFront`/`toBack` → `to_front`, `to_back`.
- **Handouts** — `createHandout` → `create_handout`.
- **Character stubs** — `createCharacter` → `create_character_stub`.
- **Token↔sheet default token** — `setDefaultTokenForCharacter` → `setDefaultToken` / `batch_exec`.
- **`add:graphic` hook** — auto-rolls initiative for NPC tokens dropped mid-combat.
- ~~**`state` persistence**~~ ✅ **DONE (relay v2.1.0)** — `round`, `turnHookEnabled`, `dmInbox`, and `mobPlans` now live in `state.GM_AI_Bridge` via the self-healing `B()` accessor, so they survive sandbox restarts / redeploys (turn hook no longer silently disarms). `CHAT_BUFFER` intentionally stays in-memory (transient; self-repopulates; persisting it would churn the campaign save). **Requires redeploying `ai-relay.js` in the Roll20 Mod editor to take effect** — by hand, per campaign (#175).
- ~~**Zone metadata**~~ ✅ **DONE** — moved off the path object into `state.GM_AI_Bridge.zones` after Roll20 was found to silently drop `name`/`gmnotes`/`fill_opacity` on `path` (#162, #164).
- ~~**Browserless page creation**~~ ✅ **DONE** — `rtCreatePage` writes the page over RTDB, mirroring an existing page's schema. `createPageViaUI` is deleted.
- ~~**Browserless art upload**~~ ✅ **DONE** — direct multipart POST with a furnished credential.
- ~~**Externally-rolled dice**~~ ✅ **DONE** — `post_roll_as_character` renders an already-rolled result as a native-looking card.

### Browser-only → out of scope (⛔)
v2.0.0 removed the browser, so these are **won't-do**, not backlog. Anything here is a manual step
for the DM in the Roll20 UI.
- ⛔ **Page deletion / reordering** — `page.remove()` isn't supported by the API and there is no DOM automation.
- ⛔ **Enabling the Mod sandbox and pasting `ai-relay.js`** — human-attended, per campaign (§3, #175).
- ⛔ **Harvesting the Roll20 realtime / upload credentials** — first-party act; the gem does it, this server only *reads* the files (`Roll20TokenUnavailableError` / `Roll20UploadCredentialError` say so out loud).
- ⛔ **Screenshots / board vision** — `screenshot_roll20` removed.
- ⛔ **Transmogrifier, marketplace/compendium drag, sheet-template selection** — UI-only.

---

## 5. Recommended next relay actions (priority order)

Note the section rename: there is no bridge to build any more. Every item below is a **new relay
action**, and nothing here needs a browser.

1. ~~**`state` persistence in the relay**~~ ✅ done (v2.1.0) — stops silent turn-hook loss on redeploy.
2. ~~**`spawnFx` + `sendPing`**~~ ✅ done — `spawn_fx` / `spawn_fx_between_points` / `send_ping`.
3. ~~**Handouts CRUD**~~ 🟡 partial — `create_handout` shipped; read/update/delete still missing.
4. **`createToken represents`** — set `represents` on create (default-token linking exists; creation-time binding doesn't), so sheet HP/AC/abilities bind without a follow-up call. Now the highest-value item: with the DDB bridge gone, a bare token is the *only* stat carrier, and it can't hold AC.
5. **Cards/decks** — `deck`/`card`/`hand` (e.g. the Tarokka deck for Curse of Strahd).
6. **Door/window update** — open/close, lock, toggle secret. (`createWalls` already makes native `pathv2`, falling back to legacy `path` only when `createObj("pathv2")` returns undefined.)
7. **Jukebox/audio + rollable tables** — ambiance and random tables.
8. **Move the player ribbon** — `Campaign().set('playerpageid', id)`.

All remaining items are **API-reachable**. Everything genuinely browser-bound is now listed as out of
scope above rather than as future work.
