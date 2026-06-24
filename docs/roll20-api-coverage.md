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

Last analyzed: 2026-06-20. Relay version string: `2.1.0` (reported by the `ping` action).

---

## 1. Architecture recap (where capability comes from)

```
Claude → MCP tool (TS) → roll20.relayCommand({action,...})
                              │  !ai-relay {JSON} — pushed over Firebase RTDB (ROLL20_TRANSPORT=rt),
                              │  or typed into Roll20 chat on the Playwright fallback
                              ▼
                       ai-relay.js (Mod sandbox)  →  Roll20 object model (createObj/findObjs/get/set)
                              ▲
                       AIBRIDGE_RESULT whispered back — read over an RTDB child listener (RT),
                       or via MutationObserver on the fallback browser path

Some capabilities skip the relay because the *sandbox* can't do them:
Claude → MCP tool (TS) → Playwright DOM on app.roll20.net   (uploadArt, createPageViaUI, takeScreenshot, getCurrentPageId, debug_turn_order)
DDB    → MCP tool (TS) → REST (Bearer cobalt) / page-context fetch / DOM scrape  (read-mostly)
```

**Three layers of "can do":**
1. **Relay actions** (70 action handlers in the `ACTIONS` dispatch map in `ai-relay.js`, plus `batchExec` sub-actions) — the real Roll20 API surface this project uses.
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
| `getSelection` | get_selection | combat | the DM's currently-selected tokens |
| `findTokensInRange` | find_tokens_in_range, resolve_aoe | combat | range query (aura/zone) |
| `getTokenById` | get_token, get/set_character_attribute, update_token_hp, create_zone, plan_tactics | both | full token read |
| `setTokenProps` | set_token_props, update_token_hp | both | arbitrary `.set(props)` |
| `setTokenBar` | full_sync_character, sync_character_state | combat | bar1 HP (NPC); `update_token_hp` uses `setTokenProps` |
| `adjustPcHp` / `getPcHp` | resolve_aoe | combat | PC HP in relay state (gmnotes block), routed by `controlledby` (only the AoE path routes here; `update_token_hp`/`update_hp_many` write the token bar directly) |
| `setStatusMarker` | (internal) | combat | single marker add/remove by tag |
| `setDefaultToken` | batch_exec (`set_default_token`) | combat | `setDefaultTokenForCharacter` (token↔sheet) |
| `toggleCondition` | set_token_marker, update_token_hp | combat | resolves via 3-tier `resolveMarkerForState`; +`active_conditions` |
| `syncConditionsToToken` | update_token_hp, sync_character_state | combat | replace all markers |
| `getTokenMarkers` | get_token_markers | combat | campaign custom markers |
| `createToken` | create_pc_token, create_monster_token, create_npc_token | maps | **does not set `represents`** |
| `createGraphic` | place_map_image, upload_and_place_map_image | maps | map-layer image |
| `createPath` / `createPaths` | (internal) | — | legacy path |
| `createWalls` | auto_place_dl_walls | maps | tries `pathv2` first, falls back to legacy `path` |
| `createPolylines` | place_polyline_walls | maps | one multi-vertex path |
| `createDLDoors` / `createDLWindows` | decorate_openings | maps | native UDL door/window (create only) |
| `clearDLOpenings` | decorate_openings | maps | delete doors+windows |
| `getWalls` | get_walls | maps | reads `pathv2` barriers |
| `getPaths` | get_paths | maps | path + optional graphic |
| `getDoors` | get_doors | maps | door/window read |
| `clearLayer` | clear_layer | maps | path+graphic+pathv2+wall |
| `debugPage` | debug_page | maps | object-type census |
| `drawLayerTest` | draw_layer_test | maps | creates `path` |
| `runUVTT` | run_uvtt_import | maps | drives external UniversalVTTImporter mod |
| `listPages` | setup_roll20_page, list_pages, get_current_page, batch_import_maps | both | page list |
| `setPageProps` | setup/rename_roll20_page | maps | name/size/scale/grid subset |
| `setPageBackground` | (internal) | — | bg color only |
| `createZone`/`clearZone`/`listZones`/`findTokensInZone` | create_zone, clear_zone, list_zones | combat | path on map layer + gmnotes meta |
| `removeObject` | remove_object | combat | graphic or path |
| `getTurnOrder`/`setTurnOrder`/`advanceTurn` | get/clear_turn_order, advance_turn, roll_initiative | combat | Campaign.turnorder |
| `mergeTurnOrder` | roll_initiative, inject_round_marker, update_turn_order | combat | NPC-only upsert (preserves PC entries) |
| `rollInitiativeForTokens` | roll_initiative | combat | real dice + epithets |
| `rollFormulas` | roll_dice | combat | real dice engine |
| `setTurnHook`/`getTurnHookState` | set/check_turn_hook | combat | enables `change:campaign:turnorder` hook |
| `sendNarration` | send_narration | combat | styled HTML to chat |
| `whisperPlayer` | whisper_player | combat | `/w <name>` |
| `getRecentChat` | get_recent_chat | combat | from in-memory CHAT_BUFFER |
| `getDmInbox`/`clearDmInbox` | get/clear_dm_inbox | combat | `!dm` queue |
| `setMobPlan`/`getMobPlans`/`clearMobPlans` | plan_tactics, plan_all_tactics, get_mob_plans, clear_tactic_memory | combat | tactical whisper cards |
| `getCustomStates` | list_custom_states | combat | tier-2 ad-hoc DM states + holders |
| `setCharacterAttributes`/`getCharacterAttributes` | set/get/read_character_attribute(s), full_sync_character | combat | sheet attrs |
| `getRepeatingSection` | plan_tactics | combat | **read-only** (e.g. npcaction); row cap (maxRows default 60, `__truncated` flag); no field projection |
| `editCharacter` | set_character_props | combat | edit top-level character fields (name/bio/avatar/controlledby/archived/inplayerjournals) |
| `batchExec` | batch_exec | combat | runs N token actions in one relay round-trip |
| `getJournalFolder`/`setJournalFolder` | get/set_journal_folder | combat | journal folder tree read/write |
| `createHandout` | create_handout | maps | lore/player handout (name, notes, gmnotes) |
| `createCharacter` | create_character_stub | maps | `createObj('character')` stub |
| `sendPing` | send_ping | maps | "look here" / pull player view to a spot |
| `spawnFx` / `spawnFxBetweenPoints` | spawn_fx, spawn_fx_between_points | maps | explosions, beams, spell nova |
| `toFront` / `toBack` | to_front, to_back | maps | z-order |
| `ping` | (health check) | — | reports relay version (2.1.0) |
| **event** `chat:message` | (passive) | — | buffers chat, parses `!dm` |
| **event** `change:campaign:turnorder` | (passive) | — | turn/round announcements |
| **event** `add:graphic` | (passive) | — | auto-rolls initiative for NPC tokens dropped during combat |
| **event** `ready` | (passive) | — | logs `state.GM_AI_Bridge` restoration on (re)deploy |

### Browser-bridge functions (Playwright; API can't do these)
| Function | Tool | What / why |
|---|---|---|
| `uploadArt` | upload_and_place_map_image | uploads a local file to Roll20 CDN — **no API path to upload art** |
| `createPageViaUI` | setup_roll20_page | clicks "Create Page" — **`createObj('page')` is unsupported** |
| `takeScreenshot` | screenshot_roll20 | Playwright page screenshot |
| `getCurrentPageId` | get_current_page (+ most tools' default page) | reads `Campaign.get('playerpageid')` via `evaluate` |
| `debug_turn_order` | debug_turn_order | raw `Campaign.turnorder` via `evaluate` |
| setcampaign navigation | switch_campaign (lazy) | `/editor/setcampaign/<id>/` |

### DDB bridge (separate; read-only)
Read: `getCharacter`, `getCharacterStats`, `getRawCharacter`, `getMonster`, `getCampaignCharacters`,
`listCampaigns`. **No writes.** All DDB write paths (`patchCharacter`, `applyCondition` /
`removeCondition`, `ddb_update_hp`, and the DDB branches of `apply_damage` / `heal_character`) have
been removed — DDB condition writes returned 405 and HP writes were unreliable. Live HP and
conditions are written exclusively to the Roll20 token; **treat DDB as ground-truth read only.**

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
- **`pathv2` DL barriers** — *read* via `getWalls`; `createWalls` now *creates* native `pathv2` (falling back to legacy `path` only if `pathv2` returns undefined). `drawLayerTest` deliberately creates `path`.
- **Door/window** — create/read/delete only; **no update** (open/close, lock, toggle secret) — all API-reachable.
- **Repeating sections** — read only; **no write** (no row-id generation / `generateRowID` helper); read has a row cap (maxRows default 60, `__truncated` flag) but no field projection.
- **Page properties** — only name/size/scale/grid/bg; UDL lighting/fog/explorer-mode/grid-type/diagonal props not exposed (all API-reachable).
- **Token↔sheet linking** — `setDefaultTokenForCharacter` IS exposed (via `setDefaultToken` / `batch_exec`), but `createToken` still doesn't set `represents` on creation, so freshly-created tokens aren't sheet-bound until a default-token call runs.
- **Events** — `chat:message`, `change:campaign:turnorder`, `add:graphic`, and `ready` wired; `destroy:graphic`, `change:graphic:statusmarkers`, etc. still unused.

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

### Shipped since this doc's first draft (✅ — no longer gaps)
- **Visual FX** — `spawnFx` / `spawnFxBetweenPoints` → `spawn_fx`, `spawn_fx_between_points`.
- **Pings** — `sendPing` → `send_ping`.
- **Z-order** — `toFront`/`toBack` → `to_front`, `to_back`.
- **Handouts** — `createHandout` → `create_handout`.
- **Character stubs** — `createCharacter` → `create_character_stub`.
- **Token↔sheet default token** — `setDefaultTokenForCharacter` → `setDefaultToken` / `batch_exec`.
- **`add:graphic` hook** — auto-rolls initiative for NPC tokens dropped mid-combat.
- ~~**`state` persistence**~~ ✅ **DONE (relay v2.1.0)** — `round`, `turnHookEnabled`, `dmInbox`, and `mobPlans` now live in `state.GM_AI_Bridge` via the self-healing `B()` accessor, so they survive sandbox restarts / redeploys (turn hook no longer silently disarms). `CHAT_BUFFER` intentionally stays in-memory (transient; self-repopulates; persisting it would churn the campaign save). **Requires redeploying `ai-relay.js` in the Roll20 Mod editor to take effect.**

### Browser-only (🌐 bridged / ⛔ not bridged)
- 🌐 **Art upload**, **page creation**, **screenshots**, **current-page read**, **campaign switch** — all bridged today.
- ⛔ **Page deletion / reordering** — `page.remove()` isn't supported by the API; would need DOM automation. Not bridged.
- ⛔ **Enabling the Mod sandbox itself / pasting the relay** — one-time manual step (documented in README).
- ⛔ **Transmogrifier, marketplace/compendium drag, sheet-template selection** — UI-only; not bridged (rarely needed).

---

## 5. Recommended next bridges (priority order)

1. ~~**`state` persistence in the relay**~~ ✅ done (v2.1.0) — stops silent turn-hook loss on redeploy.
2. ~~**`spawnFx` + `sendPing`**~~ ✅ done — `spawn_fx` / `spawn_fx_between_points` / `send_ping`.
3. ~~**Handouts CRUD**~~ 🟡 partial — `create_handout` shipped; read/update/delete still missing.
4. **`createToken represents`** — set `represents` on create (default-token linking exists; creation-time binding doesn't), so sheet HP/init/abilities bind without a follow-up call.
5. **Cards/decks** — Tarokka deck is core to the active Curse of Strahd campaign.
6. **Door/window update + native `pathv2` creation** — `createWalls` now makes `pathv2`; remaining work is door/window open/lock/secret toggles.
7. **Jukebox/audio + rollable tables** — ambiance and random tables.

All remaining items are **API-reachable** — they are new relay actions, not browser automation. The
only genuinely browser-bound work remaining is page delete/reorder and one-time sandbox setup.
