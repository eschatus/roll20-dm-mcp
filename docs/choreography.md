# End-to-End Choreography

Two complete traces showing every hop a request makes from DM speech to final state change.

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
  │  readFileSync → base64 encode image
  │
  │  HTTP POST to Anthropic API (claude-opus-4-7)
  │  body: { image: base64, prompt: "return JSON grid + walls" }
  ▼
Anthropic API
  │
  │  response: { gridSizePx: 140, gridOffsetX: 5, gridOffsetY: 3, walls: [...42 segments] }
  ▼
MCP Server (tool result returned to Claude)
  │
  │  tool call: setup_roll20_page({ name: "Dungeon Entrance", widthSquares: 30, heightSquares: 20 })
  ▼
MCP Server — src/tools/maps.ts
  │
  │  relayCommand({ action: "createPage", name: "Dungeon Entrance", ... })
  ▼
src/bridge/roll20.ts — page.evaluate()
  │
  │  types `!ai-relay {action:"createPage", name:"Dungeon Entrance", ...}` into Roll20 chat
  ▼
Roll20 Mod Sandbox — mod-scripts/ai-relay.js
  │
  │  on("chat:message") fires; sender is GM (playerIsGM check passes)
  │  createObj("page", { name, width, height, ... })
  │  whispers result `/w gm <hidden div>{ id: "pageId123" }`
  ▼
MCP Server (MutationObserver reads the whispered result div, parses pageId)
  │
  │  tool call: auto_place_dl_walls({ walls: [...42], pageId: "pageId123" })
  ▼
MCP Server — src/tools/vision.ts
  │
  │  batches 42 walls into 5 groups of ≤10
  │  for each batch: relayCommand({ action: "createPath", path: svgPath, ... }) × 10
  │  (10 parallel relay calls per batch)
  ▼
Roll20 Mod Sandbox (×42 createObj calls)
  │
  │  createObj("path", { layer: "walls", path: svgPath, ... }) for each wall segment
  ▼
Roll20 Campaign
  │  → New page "Dungeon Entrance" exists
  │  → Dynamic lighting layer has 42 wall segments
  │  → DM can enable DL and see walls immediately

Claude reports back:
  "Created page 'Dungeon Entrance'. Placed 42/42 wall segments on the DL layer."
```

**Total hops:** DM → Claude → MCP Server → Anthropic API → MCP Server → Roll20 relay (×43 relay calls) → Roll20 campaign

---

## Trace 2 — Combat Sync

**Trigger:** DM says "The naga strikes Eli for 9 piercing damage and he's poisoned."

```
DM (Claude Code)
  │
  │  natural language (via /dm-combat skill)
  ▼
Claude (MCP client)
  │  extracts: character="Eli", damage=9, conditions=["poisoned"]
  │
  │  tool call: apply_damage({ characterName: "Eli", damage: 9, conditions: ["poisoned"] })
  ▼
MCP Server — src/tools/combat.ts
  │
  │  registry.lookup("Eli") → { roll20TokenId: "tok_abc", ddbCharId: 12345678 }
  │
  │  Read current HP from the Roll20 token (source of truth):
  │    relayCommand({ action: "getToken", tokenId: "tok_abc" })
  │    → { bar1_value: 37, bar1_max: 45 }
  │  → newHp = 37 - 9 = 28
  │
  │  D&D Beyond is READ-ONLY — no HP/condition write is issued.
  │  (Optional, read-only: ddb.getCharacter(12345678) may be polled at round
  │   start to spot-check drift; it is never written.)
  │
  │  All state changes go to the Roll20 token, sequentially via the relay:
  │
  │  relayCommand({ action: "setTokenBar",
  │    tokenId: "tok_abc", value: 28, max: 45 })
  │  → Roll20 relay fires
  │  → token.set({ bar1_value: 28, bar1_max: 45 })
  │
  │  relayCommand({ action: "setStatusMarker",
  │    tokenId: "tok_abc", marker: "skull", active: true })  ← "poisoned"
  │  → Roll20 relay fires
  │  → token.set({ statusmarkers: "skull" })
  │
  │  → return result
  ▼
Claude reports:
  {
    character: "Eli",
    damageTaken: 9,
    newHp: 28,
    maxHp: 45,
    conditionsApplied: ["poisoned"],
    roll20Updated: true,
    ddbUpdated: false   // DDB is read-only; HP/conditions live on the token
  }

  "Eli takes 9 damage, now at 28/45 HP and is poisoned.
   Token HP bar and status marker updated in Roll20."
```

**Total hops:** DM → Claude → MCP Server → Roll20 relay (HP bar + status marker) → Roll20 token updated

**Note on the Roll20-only write model:** HP and conditions are written exclusively to the Roll20 token, which is the single source of truth for live combat state. D&D Beyond write code (`patchCharacter`, `applyCondition`, `ddb_update_hp`, and the DDB branches of `apply_damage` / `heal_character`) has been removed — earlier DDB condition writes returned 405 and HP writes were unreliable. DDB remains available read-only (character/monster stat lookups, optional round-start drift checks).
