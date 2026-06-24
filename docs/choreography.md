# End-to-End Choreography

Two complete traces showing every hop a request makes from DM speech to final state change.

> **Transport note (applies to every `relayCommand` below).** When `ROLL20_TRANSPORT=rt`
> is set (RT is opt-in; unset = Playwright), commands are pushed as `!ai-relay {JSON}` over the campaign's Firebase RTDB
> and the Mod's `AIBRIDGE_RESULT` is read back over an RTDB child listener — no browser needed
> (~49ms warm). On *any* RT failure (auth, timeout, disconnect, or an open circuit breaker)
> the same command (same nonce, so the Mod's `PROCESSED_NONCES` LRU deduplicates) falls back to
> the Playwright path: type `!ai-relay …` into the Roll20 chat input and read the `/w gm`
> result div via a `MutationObserver`. Some reads are served even more directly from the
> browser's live Backbone models (`CLIENT_READS` in `roll20.ts`) when a browser is attached.
> The traces below show the relay hop generically; substitute whichever transport is live.

---

## Trace 1 — Map Import Pipeline

**Trigger:** DM says "Set up the dungeon entrance map from this image file."

```
DM (Claude Code)
  │
  │  natural language
  ▼
Claude (MCP client)
  │
  │  tool call: analyze_battlemap({ imagePath: "./maps/dungeon-entrance.png" })
  ▼
MCP Server — src/tools/vision.ts
  │
  │  readFileSync → sharp downscale (≤1500px) → base64 encode image
  │
  │  HTTP POST to Anthropic API (VISION_MODEL = claude-sonnet-4-6)
  │  body: { image: base64, prompt: "return JSON grid + walls" }
  ▼
Anthropic API
  │
  │  response: { gridSizePx: 140, gridOffsetX: 5, gridOffsetY: 3, walls: [...42 segments], doors, windows }
  ▼
MCP Server (tool result returned to Claude)
  │
  │  tool call: setup_roll20_page({ name: "Dungeon Entrance", widthSquares: 30, heightSquares: 20 })
  ▼
MCP Server — src/tools/maps.ts
  │
  │  page creation is browser-only (createObj("page") is unsupported in the Mod sandbox):
  │  roll20.createPageViaUI(name, w, h, …) — Playwright clicks "Create Page", diffs the page
  │  list to learn the new pageId. Then relayCommand({ action: "setPageProps", … }) sizes it.
  ▼
Roll20 (UI automation + Mod relay for setPageProps)
  │
  │  new page "Dungeon Entrance" exists; pageId discovered → "pageId123"
  ▼
MCP Server
  │
  │  tool call: auto_place_dl_walls({ walls: [...42], pageId: "pageId123", strokeColor: "#0044FF" })
  ▼
MCP Server — src/tools/vision.ts
  │
  │  two-pass wall pipeline (geometry from analysis, optional Hough-candidate overlay/refinement)
  │  emits relayCommand({ action: "createWalls", ... }) — pathv2 paths on the DL layer
  ▼
Roll20 Mod Sandbox
  │
  │  createObj("pathv2", { layer: "walls", points, stroke: "#0044FF", barrierType, ... }) per segment
  │  (falls back to legacy "path" only if pathv2 returns undefined)
  ▼
Roll20 Campaign
  │  → New page "Dungeon Entrance" exists
  │  → Dynamic lighting layer has the wall segments (blue stroke)
  │  → DM can enable DL and see walls immediately

Claude reports back (DM-facing markdown):
  "Created page 'Dungeon Entrance'. Placed 42/42 wall segments on the DL layer."
```

**Total hops:** DM → Claude → MCP Server → Anthropic API → MCP Server → Roll20 relay (page + walls) → Roll20 campaign

---

## Trace 2 — Combat Sync

**Trigger:** DM says "The naga strikes Eli for 9 piercing damage and he's poisoned."

```
DM (Claude Code)
  │
  │  natural language (combat handled per skills/dm-rules.md + the /round workflow)
  ▼
Claude (MCP client)
  │  extracts: name="Eli", damage=9, condition="poisoned"
  │
  │  tool call: update_token_hp({ characterName: "Eli", damage: 9 })
  ▼
MCP Server — src/tools/combat.ts
  │
  │  resolveTokenOrThrow("Eli") → fuzzy-matches the live page token list → tokenId "tok_abc"
  │  → reads the token, computes isPcToken(token) (by `controlledby`). Eli is a PC.
  │
  │  D&D Beyond is READ-ONLY — no HP/condition write is issued.
  │  (Optional, read-only: ddb_get_character may be polled at round start to spot-check
  │   drift; it is never written.)
  │
  │  PC branch: HP lives in relay state (a block in the token's gmnotes), NOT the visible
  │  token bar — Beyond20 owns a player's bar1, so it is NEVER written. The relay does the
  │  read-compute-write on the tracked block:
  │    relayCommand({ action: "adjustPcHp", tokenId: "tok_abc", damage: 9 })
  │    → { current: 28, max: 45 }
  │  (If Eli were an NPC, this branch instead writes the bar:
  │   setTokenProps {bar1_value}. update_hp_many and resolve_aoe route PCs/NPCs the same way.)
  │
  ▼  (separate tool call for the condition — update_token_hp is HP-only by convention)
  │
  │  tool call: set_token_marker({ characterName: "Eli", condition: "poisoned", active: true })
  ▼
MCP Server — src/tools/combat.ts
  │
  │  relayCommand({ action: "toggleCondition", tokenId: "tok_abc", condition: "poisoned", active: true })
  ▼
Roll20 Mod Sandbox — mod-scripts/ai-relay.js
  │
  │  resolveMarkerForState("poisoned") → tier "condition" → tag "Poisoned::4444329"
  │  token.set({ statusmarkers: "...,Poisoned::4444329" }) + tracks active_conditions
  ▼
Roll20 Campaign
  │  → Eli's tracked HP (gmnotes/relay state) = 28/45; bar1 untouched.
  │  → Eli's token: statusmarkers includes Poisoned::4444329

Claude reports (DM-facing markdown report — numbers stay here, never in player chat):
  - **Eli** — 9 damage → 28/45 HP (tracked), now Poisoned.
  Changes: Eli HP 37→28 (tracked); +Poisoned.
  Actions: update_token_hp, set_token_marker.

(If the DM wants a player-visible line, send_narration carries NO numbers — e.g.
 "The naga's fangs find their mark — Eli reels, venom in his veins." See dm-rules.md.)
```

**Total hops:** DM → Claude → MCP Server → Roll20 relay (HP via adjustPcHp for a PC / setTokenProps for an NPC + condition via toggleCondition) → Roll20 token/state updated

**Note on the HP write model:** routing is by `controlledby` (`isPcToken`). A **PC's** HP is
tracked in relay state (a block in the token's gmnotes) via `adjustPcHp`, and the visible token
bar is **never** written — Beyond20 owns a player's bar1. An **NPC's** HP is `bar1` on the token.
This split is enforced identically across `update_token_hp` (single), `update_hp_many` (AoE), and
`resolve_aoe` — the "never touch a PC bar" guarantee holds on all of them. Conditions are always
written to the Roll20 token. The token/state is the source of truth for live combat.
D&D Beyond write code (`patchCharacter`, `applyCondition`, `ddb_update_hp`, and the old
`apply_damage` / `heal_character` DDB branches) has been **removed** — DDB condition writes
returned 405 and HP writes were unreliable. DDB remains available read-only (character/monster
stat lookups, optional round-start drift checks). The single HP primitive is now
`update_token_hp`; conditions go through `set_token_marker`.

---

> **Canonical conventions** (full detail in `skills/dm-rules.md`, which the Voice HUD loads at
> runtime): assistant emits a markdown report every turn and never narrates story (the DM does);
> no numbers (HP/damage/totals) in player-visible chat; narrate after every token update and at
> round end with effect countdowns; dice roll through Roll20's public roller; emanation spells use
> a token aura, fixed-area spells use `create_zone`; dead tokens move to the map layer; use
> `batch_exec` for 2+ token ops; never auto-advance the turn; PC initiative is read-only.
