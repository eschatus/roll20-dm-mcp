# Roll20 Mod (API) Coverage Map

**Purpose:** the authoritative reference for *what the Roll20 Mod (API) can do* vs. *what this
project currently exposes*, so future work doesn't keep rediscovering coverage gaps. When a
capability is marked **API-reachable but not exposed**, the fix is a new relay action (cheap).
When it's marked **browser-only**, the API genuinely can't do it and it must be driven through
the Playwright DOM bridge.

> Doc sources: the Roll20 Mod API reference lives at help.roll20.net (Zendesk) and
> wiki.roll20.net (`API:Objects`, `API:Function_documentation`, `API:Events`). **Both hard-block
> automated fetching (HTTP 403 via Cloudflare/Zendesk).** This baseline is reconstructed from
> known API surface, validated against Roll20's own summary (createObj-supported types and the
> five event types are quoted verbatim from the help center). If a future task needs a property
> table that isn't here, open the site in the existing Playwright browser session (already
> authenticated) and read it through the DOM rather than WebFetch.

Last analyzed: 2026-05-31. Relay version string: `2.0.0` (`ping` action).

---

## 1. Architecture recap (where capability comes from)

```
Claude → MCP tool (TS) → roll20.relayCommand({action,...})
                              │  !ai-relay {JSON} into Roll20 chat
                              ▼
                       ai-relay.js (Mod sandbox)  →  Roll20 object model (createObj/findObjs/get/set)
                              ▲
                       result whispered back, read by MutationObserver

Some capabilities skip the relay because the *sandbox* can't do them:
Claude → MCP tool (TS) → Playwright DOM on app.roll20.net   (uploadArt, createPageViaUI, takeScreenshot, getCurrentPageId, debug_turn_order)
DDB    → MCP tool (TS) → REST (Bearer cobalt) / page-context fetch / DOM scrape  (read-mostly)
```

**Three layers of "can do":**
1. **Relay actions** (53) — the real Roll20 API surface this project uses.
2. **Browser-bridge functions** (Playwright) — for things the Mod sandbox cannot do.
3. **DDB bridge** — separate system, read-mostly.

**Skills add nothing here.** `/combat`, `/round`, `skills/dm-combat.md`, `skills/dm-map-setup.md`
are orchestration prompts; they can only call tools that already exist. Coverage = relay + bridge.

---

## 2. Roll20 Mod API surface (the baseline)

### Object types
`createObj(type, …)` **can create** exactly these (per Roll20 docs):
`graphic`, `text`, `path`, `character`, `ability`, `attribute`, `handout`, `rollabletable`,
`tableitem`, `macro`.

**Read/queryable but NOT createObj-creatable:** `page`, `campaign`, `player`, `deck`, `card`,
`hand`, `jukeboxtrack`, `custfx`.

**Updated Dynamic Lighting (UDL) engine adds** `pathv2` (DL barriers/walls), `door`, `window` —
creatable via `createObj` on the current engine (the relay relies on this for doors/windows).

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

### Events (5 kinds)
`ready` · `change:<type>[:<prop>]` · `add:<type>` · `destroy:<type>` · `chat:message`.
Campaign specials: `change:campaign:turnorder`, `change:campaign:playerpageid`, etc.

### Campaign object
`turnorder` (JSON string), `initiativepage`, `playerpageid`, `playerspecificpages`,
`token_markers`, `_journalfolder`, `_jukeboxfolder`.

---

## 3. Relay action catalog → tool mapping

| Relay action | MCP tool(s) | Server | Notes |
|---|---|---|---|
| `getTokens` | list_tokens, roll_initiative, get_turn_order, plan_all_tactics | both | page graphics |
| `getTokenById` | get_token, get/set_character_attribute, update_token_hp, create_zone, plan_tactics | both | full token read |
| `setTokenProps` | set_token_props, update_token_hp | both | arbitrary `.set(props)` |
| `setTokenBar` | apply_damage, heal_character, full_sync_character, sync_character_state | combat | bar1 HP |
| `setStatusMarker` | set_token_marker, apply_damage | combat | single marker add/remove |
| `toggleCondition` | update_token_hp | combat | +token attr `active_conditions` |
| `syncConditionsToToken` | update_token_hp, sync_character_state | combat | replace all markers |
| `getTokenMarkers` | get_token_markers | combat | campaign custom markers |
| `createToken` | create_pc_token, create_monster_token, create_npc_token | maps | **does not set `represents`** |
| `createGraphic` | place_map_image, upload_and_place_map_image | maps | map-layer image |
| `createPath` / `createPaths` | (internal) | — | legacy path |
| `createWalls` | auto_place_dl_walls | maps | **legacy `path` on walls layer, not `pathv2`** |
| `createPolylines` | place_polyline_walls | maps | one multi-vertex path |
| `createDLDoors` / `createDLWindows` | decorate_openings | maps | native UDL door/window (create only) |
| `clearDLOpenings` | decorate_openings | maps | delete doors+windows |
| `getWalls` | get_walls | maps | reads `pathv2` barriers |
| `getPaths` | get_paths | maps | path + optional graphic |
| `getDoors` | get_doors | maps | door/window read |
| `clearLayer` | clear_layer | maps | path+graphic+pathv2+wall |
| `debugPage` | debug_page | maps | object-type census |
| `drawLayerTest` | draw_layer_test | maps | creates `path` (desc says pathv2) |
| `runUVTT` | run_uvtt_import | maps | drives external UniversalVTTImporter mod |
| `listPages` | setup_roll20_page, get_current_page | both | page list |
| `setPageProps` | setup/rename_roll20_page | maps | name/size/scale/grid subset |
| `setPageBackground` | (internal) | — | bg color only |
| `createZone`/`clearZone`/`listZones`/`findTokensInZone` | create_zone, clear_zone, list_zones | combat | path on map layer + gmnotes meta |
| `removeObject` | remove_object | combat | graphic or path |
| `getTurnOrder`/`setTurnOrder`/`advanceTurn` | get/clear_turn_order, advance_turn, roll_initiative | combat | Campaign.turnorder |
| `rollInitiativeForTokens` | roll_initiative | combat | real dice + epithets |
| `rollFormulas` | roll_dice | combat | real dice engine |
| `setTurnHook`/`getTurnHookState` | set/check_turn_hook | combat | enables `change:campaign:turnorder` hook |
| `sendNarration` | send_narration | combat | styled HTML to chat |
| `whisperPlayer` | whisper_player | combat | `/w <name>` |
| `getRecentChat` | get_recent_chat | combat | from in-memory CHAT_BUFFER |
| `getDmInbox`/`clearDmInbox` | get/clear_dm_inbox | combat | `!dm` queue |
| `setMobPlan`/`clearMobPlans` | plan_tactics, plan_all_tactics, clear_tactic_memory | combat | tactical whisper cards |
| `setCharacterAttributes`/`getCharacterAttributes` | set/get/read_character_attribute(s), full_sync_character | combat | sheet attrs |
| `getRepeatingSection` | plan_tactics | combat | **read-only** (e.g. npcaction) |
| `ping` | (health check) | — | version |
| **event** `chat:message` | (passive) | — | buffers chat, parses `!dm` |
| **event** `change:campaign:turnorder` | (passive) | — | turn/round announcements |

### Browser-bridge functions (Playwright; API can't do these)
| Function | Tool | What / why |
|---|---|---|
| `uploadArt` | upload_and_place_map_image | uploads a local file to Roll20 CDN — **no API path to upload art** |
| `createPageViaUI` | setup_roll20_page | clicks "Create Page" — **`createObj('page')` is unsupported** |
| `takeScreenshot` | screenshot_roll20 | Playwright page screenshot |
| `getCurrentPageId` | get_current_page (+ most tools' default page) | reads `Campaign.get('playerpageid')` via `evaluate` |
| `debug_turn_order` | debug_turn_order | raw `Campaign.turnorder` via `evaluate` |
| setcampaign navigation | switch_campaign (lazy) | `/editor/setcampaign/<id>/` |

### DDB bridge (separate; read-mostly)
Read: `getCharacter`, `getCharacterStats`, `getRawCharacter`, `getMonster`, `getCampaignCharacters`,
`listCampaigns`. Write: HP (`patchCharacter removedHitPoints`), conditions
(`applyCondition`/`removeCondition` via cookie-context fetch). **Most other DDB writes return 405 —
treat DDB as ground-truth read + HP/condition write only.**

---

## 4. Coverage by capability area

Legend: ✅ exposed · 🟡 partial · ❌ API-reachable but **not exposed** (add a relay action) ·
🌐 browser-only (bridged) · ⛔ browser-only **not** bridged.

### Strong (✅)
- **Tokens/graphics** — full CRUD; `setTokenProps` passes arbitrary props (bars, auras, tint, light, position, layer, gmnotes…).
- **HP & conditions** — token bars + status markers + char `active_conditions`; `batch_exec` for bulk.
- **Initiative / turn order** — read, set, advance, real-dice roll, auto announcements, round detection, epithets.
- **Dice** — real Roll20 engine via inline rolls.
- **Chat** — narration (styled), whisper, roll templates, `!ai-relay`/`!dm` command parsing.
- **Sheet attributes** — read/write flat attrs; repeating-section **read**.
- **Paths/zones & DL walls (legacy)** — create/read/clear; AoE zones with metadata.
- **DL doors/windows** — create/read/clear.
- **Pages** — list, configure (subset), create (via UI bridge).

### Partial (🟡)
- **`pathv2` DL barriers** — *read* via `getWalls`, but walls are *created* as legacy `path` objects, not native `pathv2`. (Works for lighting; isn't the modern barrier object, and `drawLayerTest`'s "pathv2" label is inaccurate.)
- **Door/window** — create/read/delete only; **no update** (open/close, lock, toggle secret) — all API-reachable.
- **Repeating sections** — read only; **no write** (no row-id generation / `generateRowID` helper).
- **Page properties** — only name/size/scale/grid/bg; UDL lighting/fog/explorer-mode/grid-type/diagonal props not exposed (all API-reachable).
- **Events** — only `chat:message` + `change:campaign:turnorder` wired; `add/destroy/change:graphic`, `ready`, etc. unused.

### API-reachable but NOT exposed (❌ — just add relay actions)
These are the "stop hitting the wall" items. None need the browser.
- **Visual FX** — `spawnFx` / `spawnFxBetweenPoints` (explosions, beams, spell nova). High value for combat.
- **Pings** — `sendPing` ("look here", pull players' view to a spot).
- **Audio** — `playJukeboxPlaylist` / `stopJukeboxPlaylist` + `jukeboxtrack` objects.
- **Move the player ribbon** — `Campaign().set('playerpageid', id)` ("bring players to this page"). *Not* browser-only.
- **Token↔sheet linking** — `createToken` never sets `represents`; `setDefaultTokenForCharacter` unused. PC/monster tokens aren't bound to sheets, so sheet-driven features (sheet HP, `getAttrByName`, auto-init bonus) silently degrade.
- **Handouts** — `handout` CRUD (lore, player handouts, images, gmnotes). Nothing exposed.
- **Rollable tables** — `rollabletable`/`tableitem` (encounter/loot tables). Nothing exposed.
- **Cards/decks** — `deck`/`card`/`hand` (e.g. **Tarokka deck for Curse of Strahd**). Nothing exposed.
- **Abilities & macros** — `ability` (token actions) / `macro` CRUD. Nothing exposed.
- **Text objects** — floating map labels/annotations. Not created, read, or removed.
- **Character object** — only attributes are touched; name/bio/gmnotes/avatar/controlledby/archived/inplayerjournals and `createObj('character')` unused.
- **Z-order** — `toFront`/`toBack` (zones rely on layer instead).
- **More on() hooks** — `add:graphic`/`destroy:graphic` (auto-detect token spawns/deaths), `change:graphic:statusmarkers`, etc.
- ~~**`state` persistence**~~ ✅ **DONE (relay v2.1.0)** — `round`, `turnHookEnabled`, `dmInbox`, and `mobPlans` now live in `state.GM_AI_Bridge` via the self-healing `B()` accessor, so they survive sandbox restarts / redeploys (turn hook no longer silently disarms). `CHAT_BUFFER` intentionally stays in-memory (transient; self-repopulates; persisting it would churn the campaign save). **Requires redeploying `ai-relay.js` in the Roll20 Mod editor to take effect.**

### Browser-only (🌐 bridged / ⛔ not bridged)
- 🌐 **Art upload**, **page creation**, **screenshots**, **current-page read**, **campaign switch** — all bridged today.
- ⛔ **Page deletion / reordering** — `page.remove()` isn't supported by the API; would need DOM automation. Not bridged.
- ⛔ **Enabling the Mod sandbox itself / pasting the relay** — one-time manual step (documented in README).
- ⛔ **Transmogrifier, marketplace/compendium drag, sheet-template selection** — UI-only; not bridged (rarely needed).

---

## 5. Recommended next bridges (priority order)

1. ~~**`state` persistence in the relay**~~ ✅ done (v2.1.0) — stops silent turn-hook loss on redeploy.
2. **Token↔sheet linking** — set `represents` on create + `setDefaultTokenForCharacter`; unlocks sheet HP/init/abilities the tactics + sync tools already assume.
3. **`spawnFx` + `sendPing`** — cheap, high-impact for live play (spell effects, "look here").
4. **Handouts CRUD** — share lore/images/secret notes with players from chat flow.
5. **Cards/decks** — Tarokka deck is core to the active Curse of Strahd campaign.
6. **Door/window update + native `pathv2` creation** — finish the DL story (open/lock/secret toggles).
7. **Jukebox/audio + rollable tables** — ambiance and random tables.

All of #1–#7 are **API-reachable** — they are new relay actions, not browser automation. The only
genuinely browser-bound work remaining is page delete/reorder and one-time sandbox setup.
