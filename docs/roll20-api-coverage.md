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
>
> **A Cloudflare challenge has been seen once.** On **2026-09-26** one fetch with the short UA
> above came back as a "Just a moment..." interstitial (~5.8 KB of JS challenge, HTTP 200) instead
> of the article. Later the same day all three articles fetched fine (HTTP 200, full article) with a
> **full** Chrome UA plus `-H 'Accept: text/html'`. So if you hit the interstitial, retry with a
> full Chrome UA string and an `Accept: text/html` header — or read the article through the
> Zendesk JSON API (`https://help.roll20.net/api/v2/help_center/en-us/articles/<id>.json`, whose
> `body` field is the article HTML) — before concluding the pages are unreachable. Save any fresh
> transcription under `data/` (gitignored) the way `data/Mod_Objects - Roll20 Wiki.html` used to
> be — the emulator's property whitelist cites it.

**Mod Script Sandbox v1.0 vs v1.5 — read this before anything else.** On **2026-09-02** Roll20 made
**v1.5 the default** for every game that had never explicitly picked a version (the old
"Experimental"/"Default" labels were renamed to 1.5/1.0 in the same release). The two are a
documented behavioral fork, they are **per-campaign** exactly like a relay deploy, and a campaign
can be moved back to 1.0 by hand. `ACTIONS["ping"]` echoes `Campaign().sandboxVersion` /
`nodeVersion` / `sheetName` and a `beacon` flag as of relay **2.7.0**, and `transport_status`
surfaces them under `sandbox` — that is how you find out which one a campaign is on. A `sandbox` of
`null` there means the *relay* is older than 2.7.0, not that the sandbox is old.

Last analyzed: **2026-09-26** (docs re-read live; repo v2.1.0). Relay version string: `2.10.0`
(reported by the `ping` action, and echoed in the Mod console's load banner). **Deploying the relay is a manual, per-campaign
paste** — `deploy_mod_script` and `npm run release:mod` are deleted; verify the *load* banner
(`[GM_AI_Bridge] Relay script loaded (v2.10.0)`), not the save.

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
1. **Relay actions** (76 action handlers in the `ACTIONS` dispatch map in `ai-relay.js`, plus `batchExec` sub-actions) — the real Roll20 API surface this project uses.
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
relay's `createWalls` no longer carries a legacy-`path` fallback (it was dead code that hardcoded a
yellow stroke against the project's blue-wall convention — removed in #207).

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
- `findObjs` options now include **`tagMatch: 'all' | 'any' | 'only'`** beside `caseInsensitive`
  and `startsWith` — `'all'` (default) means the object carries every listed tag, `'any'` at least
  one, `'only'` exactly the listed set. **Not adopted, and deliberately so (#209):** the live
  Objects page (re-read 2026-09-26) lists a `tags` property on **character** and **handout** only —
  graphics, paths and text have none. So `tagMatch` is inert for token lookup, the one place it
  could have replaced `resolveToken`'s name matching: tokens carry no tags to match. It could
  filter characters or handouts if a use for that ever appears; nothing here needs one today.
- Card/deck helpers: `shuffleDeck`, `cardInfo`, `recallCards`, `dealCardsToTurn`, `drawCard`,
  `pickUpCard`, `takeCardFromPlayer`, `playCardToTable`, `giveCardToPlayer`. Available on both
  sandboxes. **Not adopted (#209):** nothing at the table uses decks yet. This is the same gap as
  §5 item 5 (the Tarokka deck for Curse of Strahd) and belongs to that item, not to a speculative
  wrapper per helper — a deck feature wants the `deck`/`card`/`hand` object CRUD *and* these
  helpers designed together.

**Sandbox v1.5 only:**
- `getComputed` / `setComputed` / `performAction` — Beacon sheet computed properties and sheet
  actions; enumerate them with `Campaign().computedSummary` / `actionSummary`. **Wired as of relay
  2.10.0** — see "Beacon sheet carriers" below.
- ~~`toAbove(obj, target)` / `toBelow(obj, target)`~~ ✅ **wired (relay 2.9.0)** as `to_above` /
  `to_below` — precise layer ordering, which `to_front`/`to_back` cannot express. The relay refuses
  on v1.0 with the campaign's sandbox version named rather than letting `toAbove is not defined`
  surface, and refuses a cross-page or cross-layer pair rather than reporting `ok:true` for a no-op
  (z-order is per-page and per-layer). `toFront`/`toBack` are also "substantially faster" here, and graphics/paths/text gain
  `.toFront()` / `.toBack()` instance methods (the globals still work; nothing here needs changing).
- `spawnFxBetweenPoints` beam types point at the end point (an angle bug is fixed).
- `log` error messages carry a context object (e.g. `[Roll20 character -id]`); the Apr 2026 server
  release added per-script callstacks with script name, tab number, line and column, plus
  attribution for "Possible Infinite Loop Detected". **Read the Mod console callstack FIRST** when
  the sandbox dies: both crash classes this repo has burned days on — an `undefined`/`NaN` value
  reaching `t.set()`, and `@{`/`[[` echoed back through chat — presented as nothing but a dead
  sandbox, and are now attributable in one look (#209).
- Graphic `currentSide` — setting it auto-updates `imgsrc` for rollable tokens. Exposed through
  `set_token_props` as of #204; the write is harmless on v1.0, it just does nothing there.

### Campaign() direct properties (NOT behind `.get()`)
`sandboxVersion` (`"1.0"`/`"1.5"`) · `nodeVersion` — both sandboxes.
`sheetName` · `computedSummary` · `actionSummary` — v1.5 only.

**Beacon sheets are a live hazard for the attribute path.** A Beacon ("advanced") sheet keeps
*some* character data in computed properties. Data held that way is not reachable as an attribute:
`findObjs({_type:"attribute"})` cannot see it and `createObj("attribute")` cannot reach it — the
object is created, and the sheet never reads it. That is NOT the same as attributes being dead on a
Beacon sheet: the live `setAttrs` spike in #225 wrote attributes, fired sheet workers and
materialised `rollbase`/`attack_onhit` on a sandbox 1.5 `ogl5e` campaign. As
of relay 2.7.0 `setCharacterAttributes` refuses that write and reports it under `failed` with a
reason, rather than reporting `created` for a write that did nothing
(`test/sandbox-handshake.test.ts`). Relay **2.10.0** adds the carriers that actually reach the data
(#205) — see the next section.

### Beacon sheet carriers (relay 2.10.0, #205)

Roll20's own signatures, which differ between the two families and are easy to get backwards — the
sheet-item pair is POSITIONAL, the Beacon trio takes ONE OBJECT:

```
getSheetItem(characterId, property, valtype?, options?)          -> Promise   v1.0 + v1.5
setSheetItem(characterId, property, value, valtype?, options?)   -> Promise   v1.0 + v1.5
getComputed({ characterId, property, args?, playerId? })         -> Promise   v1.5 only
setComputed({ characterId, property, args?, playerId? })         -> Promise   v1.5 only
performAction({ characterId, action, args?, playerId? })         -> Promise   v1.5 only
```

| relay action | MCP tool | notes |
|---|---|---|
| `getSheetSummary` | `get_sheet_summary` | `computedSummary` + `actionSummary` + which carriers exist. The "what can I even call" read — start here when a character read comes back empty. |
| `getSheetItem` | `get_sheet_item` | version-agnostic read; `names[]` batches, and a per-name failure is isolated into `failed`/`reasons` instead of costing the batch |
| `setSheetItem` | `set_sheet_item` | version-agnostic write; `attributes` mirrors `setCharacterAttributes` (a `{current,max}` value becomes two calls, labelled `hp` and `hp:max`). Any failed field makes the MCP result `isError` (`partial:true`), still listing `written` |
| `getComputed` | `get_computed_property` | `known:false` flags a name that is not in `computedSummary` |
| `setComputed` | `set_computed_property` | returns void, so the result carries a `readBack` (read with the same `args`). A scalar `value` is compared against it: mismatch → `ok:false`/`verified:false` and an `isError` MCP result; args-only writes are `verified:null` |
| `performAction` | `perform_sheet_action` | the action name travels as **`actionName`** — the dispatcher eats the command's `action` field as the relay action to run. `known:true` = in `actionSummary`; `known:null` = `actionSummary` has entries whose names could not be read, so the call goes through unverified; `known:false` = absent, and then a same-named character *ability* is only invoked with an explicit **`allowAbilityFallback:true`** (a name matching neither is refused before the call is made) |

Four things about this path are load-bearing:

- **Async, with a deferred `writeResult`.** Every carrier returns a Promise and every `ACTIONS`
  handler is synchronous. `settleSheetAsync` writes the result from the settlement — the same
  pattern `rollFormulas` uses for its `sendChat` callbacks, and the first *write* to need it. It
  also owns a **6s timeout**, deliberately under the TS side's 8s read / 30s write relay timeouts,
  so a carrier that never settles is reported by name instead of surfacing as an opaque transport
  timeout; the timer is cleared on settlement, and the timeout error says the call may still land
  (read back before retrying) — a timeout is not evidence of failure. Rejections are caught there too:
  the dispatcher's `try/catch` only wraps the synchronous half of a handler, so an uncaught one would
  be an unhandled rejection and a silent 30s wait. `getSheetDefaultValues` rides the same helper when
  its getter turns out to be a thenable. The nonce is marked **in flight** at dispatch
  (`markNoncePending`): a same-nonce resend that arrives before settlement gets an "still in flight"
  error rather than a second carrier call — the replay cache used to be filled only by `writeResult`,
  so a mid-flight resend of `performAction` could fire an attack twice.
- **The ability fallback is a chat macro.** When `actionName` is not a Beacon action, Roll20 runs
  the same-named character ability through its own `sendChat`, outside this script's `chatSend()`
  chokepoint and carrying whatever `@{`/`[[`/`%{` the ability body holds. That is exactly the class
  of call the chat-trigger rule exists to keep off the wire, so the relay refuses it unless the
  caller passes `allowAbilityFallback:true` — a deliberate act, not a default.
- **`allowThrow` defaults to TRUE**, inverting Roll20's default. Left off, `setSheetItem` resolves
  whether or not the write landed — on a Beacon sheet a property that is missing or read-only fails
  silently, which is the same "reported success, did nothing" failure the Beacon guard in
  `setCharacterAttributes` exists to kill. A caller that wants the lenient behaviour must ask for
  `allowThrow:false`, and the result then carries a note saying `written` is not evidence.
- **`setComputed`'s value key is not published.** Roll20 documents the payload as
  `{characterId, property, args?, playerId?}` and never says where the new value sits (and `args`
  being optional argues it is not simply that). The relay therefore forwards `args` **and** `value`
  verbatim and refuses a call carrying neither, rather than guessing a key that would write
  nothing. `readBack` is how you find out which one your sheet wanted.

**Still unverified live.** No v1.5 Beacon campaign was available when this landed, so the signatures
above are transcribed from `help.roll20.net/hc/en-us/articles/360037772833`. Three things a live
Beacon campaign should settle: which of `args`/`value` `setComputed` reads; whether `performAction`'s
documented fallback to a same-named character ability is Roll20's own (the relay assumes it is and
deliberately does **not** fire its own `sendChat`, which would double-trigger the ability —
`known:false`/`abilityFallback:true` is the caller's signal that the call went down that path, and
the relay checks the ability exists first so a name matching neither is refused); and the element shape of
`computedSummary`/`actionSummary` (`summaryNames` accepts plain strings and the obvious
descriptor-object forms; when `actionSummary` is non-empty but yields no names, `performAction`
reports `known:null` and lets the call through rather than refusing every real action). The
emulator's `setComputed` accepting `value` or `args.value` is a **test guess** for exercising the
read-back comparison, not a transcription of anything Roll20 publishes.

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
| `getTokenById` | get_token, get/set_character_attribute, update_token_hp, kill_token, revive_token, set_pc_dying, break_concentration, create_zone | both | full token read (direct-read path) |
| `setTokenProps` | set_token_props, kill_token (→ map layer), revive_token (→ token layer), create_pc_token, batch_exec | both | arbitrary `.set(props)`; direct-write path |
| `setTokenAura` | set_token_aura, resolve_aoe (`draw:"aura"`) | combat | one aura slot (1\|2) set or cleared — radius/colour/shape/visibility — **plus** the record of which slot a concentration effect owns (`state.GM_AI_Bridge.concentrationAuras`, #210), so `breakConcentration` tears down that slot instead of assuming slot 1. Recasting onto the other slot zeroes the ring the spell used to own; clearing/repurposing the slot releases the claim (slot 0); an untagged slot-1 ring drawn over a released claim resets the token to untracked (slot-1 teardown again), while an untagged slot-2 ring keeps it released. Shape is written to `aura{n}_options` only. A raw `setTokenProps` write of `aura{n}_radius` is forced through the Mod so it releases the claim on the slot it overwrites. |
| `setTokenBar` | update_token_hp (NPC/sidekick), update_hp_many, revive_token (NPC/sidekick), roll_initiative (`entries[].hp` seed), resolve_aoe | combat | bar1 HP; direct-write path |
| `adjustPcHp` / `getPcHp` | update_token_hp, update_hp_many, revive_token, resolve_aoe (all PC-routed writes) | combat | PC HP in a `%%PCHP={…}%%` block in the token's gmnotes, routed three ways by `classifyToken` (PC / NPC / sidekick). `getPcHp` has no tool of its own — it's the direct-read half of the same carrier. **Never write a PC's token bar.** |
| `setStatusMarker` | (internal) | — | single marker add/remove by tag; direct-write path |
| `setDefaultToken` | batch_exec (`set_default_token`) | combat | `setDefaultTokenForCharacter` (token↔sheet) |
| `toggleCondition` | set_token_marker, update_token_hp, kill_token, revive_token, set_pc_dying, batch_exec | combat | resolves via 3-tier `resolveMarkerForState`; +`active_conditions`; direct-write path |
| `syncConditionsToToken` | update_token_hp (`replaceConditions`) | combat | replace all markers |
| `breakConcentration` | break_concentration, set_pc_dying (auto-cascade) | combat | removes the `Concentrating` marker, zeroes the aura slot the effect OWNS (`concentrationAuras` — #210; slot 1 for a never-tracked token, no aura at all for a released claim), and deletes zones whose duration is `{type:'concentration', caster}` (#134/#135) |
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
| `pathv2ZoneProbe` | — (recon only: `src/recon/pathv2-zone-probe.ts`) | — | **spike instrument, issue #208** — draws one `pathv2` per variant (`eli`/`rec`/`pol` × fill forms × layer) and reports what Roll20 stored, to settle whether `pathv2` should replace `path` as the zone primitive. Leaves the objects on the page on purpose and stashes their ids in `state.GM_AI_Bridge.pathv2Probe`; `{ clearLast: true }` removes them. Registered by no server. Delete once the spike's Results are in. See `docs/pathv2-zone-spike.md`. |
| `runUVTT` | run_uvtt_import | maps | drives external UniversalVTTImporter mod |
| `listPages` | list_pages, get_current_page, setup_roll20_page, rename_roll20_page, batch_import_maps | both | page list (direct-read path) |
| `setPageProps` | setup_roll20_page, rename_roll20_page, batch_import_maps | maps | name/size/scale/grid subset |
| `setPageBackground` | (internal) | — | bg color only |
| `createZone`/`clearZone`/`listZones`/`findTokensInZone`/`processRoundEndZones` | create_zone, clear_zone, list_zones, process_round_end_zones, resolve_aoe | both | path on the map layer; **metadata lives in `state.GM_AI_Bridge.zones`, not on the path object** (path objects silently drop `name`/`gmnotes`/`fill_opacity` — #162/#164). Whether `pathv2` (`shape:"eli"`/`"rec"`, real `fill`) is a better drawing primitive is an open spike — `docs/pathv2-zone-spike.md` (#208). |
| `removeObject` | remove_object | combat | graphic or path |
| `getTurnOrder`/`setTurnOrder`/`advanceTurn` | get_turn_order, clear_turn_order, advance_turn, update_turn_order, inject_round_marker, revive_token (read only), batch_exec | combat | `Campaign.turnorder`. **Never write `setTurnOrder` wholesale** — it erases player entries; only `clear_turn_order` does that deliberately. |
| `mergeTurnOrder` | roll_initiative, inject_round_marker, update_turn_order, revive_token | combat | NPC-only upsert (preserves PC entries). `keepTurn:true` (relay 2.9.0, revive_token) splices into the live rotation without the pr-descending sort, so row 0 (the active turn) never changes |
| `rollInitiativeForTokens` | roll_initiative, revive_token (silent re-roll when a kill took an NPC/sidekick entry; never for a true PC) | combat | real dice + epithets; honours per-combatant `bonusOverrides` from `entries[].bonus` (#172) |
| `rollFormulas` | roll_dice, resolve_aoe | combat | real dice engine — all dice go through Roll20's roller, never a TS RNG |
| `setTurnHook`/`getTurnHookState` | set_turn_hook, check_turn_hook | combat | enables the `change:campaign:turnorder` hook; `roll_initiative` arms it itself |
| `sendNarration` | send_narration | combat | styled HTML to chat |
| `postChat` | post_roll_as_character | combat | renders an **already-rolled** result as a named roll card — never re-rolls. The bridging seam for dice rolled outside Roll20. |
| `whisperPlayer` | whisper_player | combat | `/w <name>` |
| `getRecentChat` | get_recent_chat | combat | from the in-memory chat buffer (direct-read path) |
| `getDmInbox`/`clearDmInbox` | get_dm_inbox, clear_dm_inbox | combat | `!dm` queue |
| `setMobPlan`/`getMobPlans`/`clearMobPlans` | set_mob_plan, get_mob_plans, clear_mob_plans | combat | **storage only.** The server no longer *plans* anything — the tactics tools (`plan_tactics`, `plan_all_tactics`, `record_tactic_outcome`, `get/clear_tactic_memory`) are removed and the gem owns tactical planning; this is just where it parks the resulting whisper cards. |
| `setCharacterAttributes`/`getCharacterAttributes` | set_character_attribute, get_character_attribute, read_character_attributes | combat | sheet attrs. **Never read a field containing literal `@{`/`[[`** (e.g. `rollbase`) — Roll20's chat pipeline live-evaluates it on echo. |
| `getSheetDefaultValues` | get_sheet_default_values | combat | `getSheetDefaultValue(name, valtype?)` per requested name — the **sheet's** default, not a character's value, so a stat-block writer can tell "never set" from "set to exactly the default". Campaign-wide (no `charId`). Unknown names come back under `missing`, never as a default of `null`. Roll20 doesn't document whether the getter is sync or async, so a thenable return is resolved rather than serialised as `{}`. |
| `getSheetSummary`/`getSheetItem`/`setSheetItem`/`getComputed`/`setComputed`/`performAction` | get_sheet_summary, get_sheet_item, set_sheet_item, get_computed_property, set_computed_property, perform_sheet_action | combat | **Beacon ("advanced") sheet access, #205.** The only path that reaches a v1.5 sheet's computed properties; all six are **async** (deferred `writeResult`, 6s timeout). See "Beacon sheet carriers" above. |
| `getRepeatingSection` | *(none)* | — | **read-only** (e.g. npcaction); row cap (maxRows default 60, `__truncated` flag); no field projection. Orphaned since tactics moved to the gem — the action still exists but no MCP tool calls it. |
| `editCharacter` | set_character_props | combat | edit top-level character fields (name/bio/avatar/controlledby/archived/inplayerjournals) |
| `batchExec` | batch_exec, update_hp_many, resolve_aoe, roll_initiative (HP seeding) | combat | runs N token actions in one relay round-trip |
| `getJournalFolder`/`setJournalFolder` | get_journal_folder, set_journal_folder | combat | journal folder tree read/write (direct paths) |
| `createHandout` | create_handout | combat | lore/player handout (name, notes, gmnotes) |
| `createCharacter` | create_character_stub | combat | `createObj('character')` stub; derives `<ability>_mod` from the raw score at creation (sheet workers never fire on API-created attrs) |
| `sendPing` | send_ping | maps | "look here" / pull player view to a spot |
| `spawnFx` / `spawnFxBetweenPoints` | spawn_fx, spawn_fx_between_points | maps | explosions, beams, spell nova |
| `toFront` / `toBack` | to_front, to_back | maps | z-order (all-the-way front/back) |
| `toAbove` / `toBelow` | to_above, to_below | maps | z-order **relative** to another object. **Sandbox v1.5 only** — refuses on v1.0 naming the version and the `toFront`/`toBack` fallback. Both objects must share a page **and** a layer (z-order is page- and layer-local; either mismatch is refused rather than reported as an `ok:true` no-op). **Maps server only**, matching `to_front`/`to_back` — z-order is map-prep work; a combat-side registration is a follow-up if the table ever needs it live. |
| `ping` | (health check) | — | reports relay version (2.10.0); drives the `EXPECTED_RELAY_VERSION` handshake surfaced by `transport_status` |
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
  `set_token_props` validates the presentation/behaviour properties added in #204:
  `bar{1,2,3}_num_permission` (`everyone` | `hidden` | `""` = editors only), `lockMovement`,
  `renderAsScenery`, `baseOpacity` / `fadeOnOverlap` / `fadeOpacity`, `night_vision_effect`,
  `bar_location` / `compact_bar`, `currentSide` (v1.5), `interactionManualReset` (an action —
  `true` resets the object's interactions) / `interactionTriggered` (state Roll20 sets when the
  interaction fires; read it back via `get_token`). NPC HP digits are editor-only by Roll20's
  default (`""`; an NPC token has no controllers, so only the GM reads them) — the creation tools
  write nothing unless `showHpNumbersToPlayers: true` opts a token into `"everyone"`.
  **Anything a creation path sets must also appear in `setDefaultTokenForChar`'s KEYS list**
  in `ai-relay.js`, or it is silently lost when the sheet's default token is applied. The two
  interaction flags are deliberately excluded (a default token must not replay a reset).
  Roll20 now also documents a **4th bar** (`bar4_*`); it is not yet exposed by any tool.
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
- **`pathv2` DL barriers** — *read* via `getWalls`; `createWalls` *creates* native `pathv2` only — no legacy-`path` fallback (#207); a `pathv2` miss throws and rolls back the walls that call already placed. `drawLayerTest` deliberately creates `path`.
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
- **Z-order** — `toFront`/`toBack` → `to_front`, `to_back`; `toAbove`/`toBelow` → `to_above`,
  `to_below` (relay 2.9.0, **sandbox v1.5 only**).
- **Sheet defaults** — `getSheetDefaultValue` → `get_sheet_default_values` (relay 2.9.0), the
  "unset vs. default" comparison `getCharacterAttributes` cannot make on its own.
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
6. **Door/window update** — open/close, lock, toggle secret. (`createWalls` already makes native `pathv2`, with no legacy-`path` fallback — #207.)
7. **Jukebox/audio + rollable tables** — ambiance and random tables.
8. **Move the player ribbon** — `Campaign().set('playerpageid', id)`.

All remaining items are **API-reachable**. Everything genuinely browser-bound is now listed as out of
scope above rather than as future work.
