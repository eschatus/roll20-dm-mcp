# Relay Payload Slimming — Spec

Trim the relay's read payloads down to what's actually consumed, on the hot paths the voice agent
hits every turn. Pure context/transport savings — **no behavior change**. One relay redeploy covers
all of it.

## Why

The waste lands in three places, worst first:

1. **Chat buffer re-scan (biggest).** `CHAT_BUFFER` stores `content: msg.content.slice(0, 600)` of
   raw HTML — Beyond20/Roll20 rolltemplates carry inline styles, dice-face images, and the character
   **avatar `imgsrc`** in the markup. `get_recent_chat` returns those raw, and the agent scans it
   every turn for rolls. ~600 chars × ~30 msgs ≈ **~5k tokens of mostly-markup, re-read constantly**.
   Worse: the relay's own `AIBRIDGE_RESULT:` outputs are whispers that slip past the `!ai-relay`
   filter and get buffered — so tool results (imgsrc included) come back *again* as chat.
2. **LLM context per token read.** The roster text has no HP, so "who's hurt?" forces a direct
   `list_tokens` call; that full JSON (incl. `imgsrc` ~120 chars/token) goes straight into message
   history via `pushToolResults`. ~26 tokens of art URLs ≈ ~1k tokens the model never reads.
3. **Relay transport, every roster refresh.** `getTokens` ships all 13 fields over the Roll20
   chat-message channel (`AIBRIDGE_RESULT`), which has a size ceiling — fat payloads risk silent
   truncation.

The roster builder ([voice-hud/src/roster.ts](../voice-hud/src/roster.ts)) already strips to
`name/layer/controlledby/represents` client-side, so `imgsrc` never reaches the LLM *via roster* —
but it still costs (1) and (3), and direct reads still cost (2).

## Decisions (locked)

- **Full profile system** for tokens (not just dropping `imgsrc`).
- **Keep geometry** in the default `list_tokens` read.
- **Chat:** stripped-text gist **+** structured `inlinerolls`.
- **Never buffer AI/bridge messages** — exclude all `playerid === "API"` output from `CHAT_BUFFER`.

## Surface 1 — token projections

Add one shared helper; replace the three hand-rolled projections (`getTokens`, `getSelection`,
`findTokensInRange`) with it.

```js
// Field profiles. imgsrc is in NONE — no live caller reads it (art uses createGraphic-type
// actions, never read-back).
function tokenSummary(t, profile) {            // profile: "lean" | "status" | "full"
  const s = {
    id: t.id,
    name: t.get("name"),
    represents: t.get("represents") || "",
    controlledby: t.get("controlledby") || "",
    layer: t.get("layer"),
  };
  if (profile === "lean") return s;
  s.bar1_value = t.get("bar1_value");          // HP
  s.bar1_max   = t.get("bar1_max");
  s.statusmarkers = t.get("statusmarkers");    // conditions
  if (profile === "status") return s;
  s.left = t.get("left"); s.top = t.get("top");          // geometry
  s.width = t.get("width"); s.height = t.get("height");
  return s; // "full"
}
```

| Profile | Fields | Used by |
|---|---|---|
| `lean` | id, name, represents, controlledby, layer | roster refresh (`list_tokens` profile=`lean`) |
| `status` | lean + bar1_value/max, statusmarkers | HP/condition reads that don't need position |
| `full` | status + left/top/width/height | **`list_tokens` default** (keep geometry); `findTokensInRange`; `getSelection` |

- `getTokens` accepts `args.profile`, **defaults to `full`** (so `list_tokens` keeps geometry per
  decision) — but `imgsrc` is gone from every profile.
- `roster.ts` passes `profile: "lean"` (it only matches names/identity) to cut transport.
- `getSelection` adds its resolved `characterName` on top of `full`.
- `findTokensInRange` keeps its computed `distanceFeet`, body from `full`.

Net token saving: `imgsrc` removed everywhere (~1k tokens/direct-read, plus transport). Geometry and
HP retained per decision.

## Surface 2 — getSelection / findTokensInRange

Route both through `tokenSummary(t, "full")` + their extra computed field(s). DRY only; no field
change beyond losing `imgsrc` (neither shipped it anyway — this just unifies the code).

## Surface 3 — chat buffer (the big win)

Two changes in the `on("chat:message")` handler ([ai-relay.js:357](../mod-scripts/ai-relay.js#L357)):

**(a) Exclude bridge/AI messages.** Extend the **existing buffer-push condition** (don't add early
returns — the `!dm` inbox branch lives in the same handler and must stay reachable) so the relay
never re-ingests its own output (AIBRIDGE_RESULT whispers, Initiative announces, whisperPlayer, NPC
roll echoes — all `playerid === "API"`):

```js
on("chat:message", function (msg) {
  // Buffer only real table chat: not relay commands, not our own API/bridge output.
  if (msg.content && typeof msg.content === "string"
      && !msg.content.startsWith("!ai-relay")
      && msg.playerid !== "API") {                       // <-- new guard
    CHAT_BUFFER.push({
      who: msg.who || "",
      type: msg.type || "",
      content: cleanChat(msg.content),                    // cleaned, not raw 600-char slice
      inlinerolls: (msg.inlinerolls || []).map(r => ({
        expression: r.expression, total: r.results ? r.results.total : null,
      })),
      timestamp: Date.now(),
    });
    if (CHAT_BUFFER.length > CHAT_BUFFER_MAX) CHAT_BUFFER.shift();
  }

  // ... existing !dm inbox handling stays exactly as-is, after this block ...
});
```

Beyond20 player rolls keep a real `playerid`, so they're retained; only script-sent messages drop
out. The agent never needed to scrape relay roll echoes from chat anyway — those come back through
`writeResult`/`inlinerolls` directly.

**(b) Clean content at push.** Strip markup so the dice/text signal survives without the HTML:

```js
function cleanChat(raw) {
  return String(raw)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(div|p|tr|td|li)>/gi, " ")
    .replace(/<[^>]+>/g, "")                 // drop all tags (kills <img>, styled spans)
    .replace(/https?:\/\/\S+/g, "")          // drop bare URLs (avatars/marketplace art)
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);                          // cleaned text is dense; 240 >> 600 raw
}
```

Why this is safe to do destructively at push: nothing downstream needs raw rolltemplate HTML, and
**`inlinerolls` is captured separately** ({expression,total}) — so even aggressive stripping never
loses a roll total. The DM inbox stores its own `dmText` independently.

Effect: that ~5k-token scan drops to ~1k, roll totals intact, and the AIBRIDGE feedback loop is
gone.

---

# Tier 2 — occasional-but-huge payloads (map / sheet reads)

These aren't in the live voice allowlist, so they don't recur per turn — but each is **O(map or
sheet complexity)** and a single call can dominate a Claude Code context window. Ranked by blast
radius.

## T2.1 — `getWalls` / `getPaths`: omit raw geometry by default (biggest)

`getWalls` ships `points` (full coordinate array per DL barrier) and `getPaths` ships `path` (entire
SVG point string per path). On a mapped dungeon that's hundreds of objects × many points =
**tens of KB**. Add a geometry flag; **default to a metadata summary**:

```js
// getWalls
let includePoints = args.includePoints === true;
writeResult(nonce, walls.map(function (w) {
  let pts = w.get("points");
  let base = { id: w.id, barrierType: w.get("barrierType"), shape: w.get("shape"),
               x: w.get("x"), y: w.get("y"),
               pointCount: Array.isArray(pts) ? pts.length : 0,
               bbox: bboxOf(pts) };          // {minX,minY,maxX,maxY} — cheap, tells you placement
  if (includePoints) base.points = pts;      // opt-in only
  return base;
}));
```

`getPaths`: same shape — gate `path` (and the re-added `imgsrc` at [:750](../mod-scripts/ai-relay.js#L750))
behind `args.includePath`; default returns `id, layer, bbox, pointCount`.

> **Caller audit required.** Map/vision code that verifies placement (e.g. `auto_place_dl_walls`,
> the `get_walls`/`get_paths` tools) may genuinely need full geometry — pass `includePoints` /
> `includePath` from those call sites so default-lean doesn't break placement checks. The point is
> the *model* shouldn't get raw points unless it asked.

## T2.2 — `read_character_attributes`: never return the full sheet

The relay's `getCharacterAttributes` already honors `args.names` — but unfiltered it returns **every**
attribute (200–600+ `{current,max}` per 5e sheet, ~12KB; round-start spot-checks fan this ×PCs). Fix
at the **MCP tool**: require `names[]`, or default it to the canonical combat subset
(`hp/ac/speed/saves/key skills/spell_slots/…`). Full-sheet dumps should be impossible without an
explicit "give me everything" flag.

## T2.3 — `getRepeatingSection`: project + cap

O(rows × fields) — a caster's spell list or an NPC's action block. Field-project to the columns
actually read and cap row count (with a `truncated` flag) for very long sections.

## T2.4 — `ddb_list_campaign_characters`: project to `{id, name}`

[ddb.ts:45](../src/tools/ddb.ts#L45) returns raw `JSON.stringify(chars)`, but the only consumer
([roster.ts](../voice-hud/src/roster.ts)) reads `name`/`id`. Project to `chars.map(c => ({ id, name }))`.
This is the one Tier-2 item on the **voice** path (once per session, cached).

## T2.5 — cross-cutting sweep

- **Drop surviving art URLs:** `getPaths.imgsrc` (gated above), `ddb_get_character.avatarUrl`
  ([ddb.ts:26](../src/tools/ddb.ts#L26)), `ddb_get_monster.largeAvatarUrl`
  ([ddb.ts:102](../src/tools/ddb.ts#L102)) — same never-read class as token `imgsrc`.
- **Compact stringify:** drop `JSON.stringify(x, null, 2)` on model-facing tools (e.g.
  `ddb_list_campaigns` [ddb.ts:59](../src/tools/ddb.ts#L59)) — pretty-print adds 20–40% whitespace.
- **`getTurnOrder`:** drop the repeated `_pageid` per entry (trivial).

## Already lean — do NOT touch

`findTokensInRange` ([:1205](../mod-scripts/ai-relay.js#L1205)), `getTurnOrder` body,
`ddb_get_character` / `ddb_get_monster` (already ~8-field projections — only the avatar URLs go).

## Deployment & verification

- **Relay redeploy required** (paste `ai-relay.js` into the Roll20 API console) — covers Tier 1
  (token/chat) **and** the relay half of Tier 2 (`getWalls`/`getPaths`/`getRepeatingSection`/
  `getTurnOrder`). One paste.
- **MCP rebuild** (`npm run build` + restart) for the source-side changes: `roster.ts` passes
  `profile: "lean"`; `list_tokens` optionally exposes `profile` (defaults to relay `full`);
  `read_character_attributes` requires/defaults `names[]`; `ddb.ts` projects
  `ddb_list_campaign_characters` and drops avatar URLs / pretty-print.
- **Caller audit (Tier 2.1):** before defaulting `getWalls`/`getPaths` to summary, set
  `includePoints`/`includePath` at the map/vision call sites that need full geometry (placement
  verification) so default-lean doesn't break wall placement.
- **Verify Tier 1:** before/after byte size of one `list_tokens` and one `get_recent_chat limit=30`
  on a live ~26-token page; confirm (1) no `imgsrc`/URLs in either, (2) roll totals still in
  `inlinerolls`, (3) no `AIBRIDGE_RESULT`/`GM-AI-Bridge` entries in the chat buffer.
- **Verify Tier 2:** `get_walls` returns `pointCount`+`bbox` (not raw points) by default but full
  geometry with `includePoints`; `read_character_attributes` with no `names` returns the bounded
  subset, not the whole sheet; placement tools still lay walls correctly (caller-audit check).

## Relationship to phase scaffolding

Orthogonal. Phases cut *how many tools* the model sees; this cuts *how fat each result is*. Ship
independently — this one has no behavior change and makes every downstream turn cheaper.
```
