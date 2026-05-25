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
  │  sets GM_AI_Bridge_cmd attribute in Roll20 campaign
  ▼
Roll20 Mod Sandbox — mod-scripts/ai-relay.js
  │
  │  on("change:attribute") fires for GM_AI_Bridge_cmd
  │  createObj("page", { name, width, height, ... })
  │  sets GM_AI_Bridge_result = { id: "pageId123" }
  ▼
MCP Server (polls GM_AI_Bridge_result, reads pageId)
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
  │  ddb.getCharacter(12345678) → { maxHp: 45, removedHitPoints: 8, ... }
  │  → currentHp = 45 - 8 = 37; newRemovedHp = 8 + 9 = 17; newHp = 45 - 17 = 28
  │
  │  Promise.all([Roll20 path, DDB path]) — both run concurrently
  │
  ├─────────────────────────────────────────────────────────┐
  │  Roll20 path                                            │  DDB path
  │                                                         │
  │  relayCommand({ action: "setTokenBar",                  │  fetch PATCH /api/v5/character/12345678
  │    tokenId: "tok_abc", value: 28, max: 45 })            │  body: { removedHitPoints: 17 }
  │                                                         │  header: x-cobalt-token: <cookie>
  │  → Roll20 relay fires                                   │
  │  → token.set({ bar1_value: 28, bar1_max: 45 })          │  fetch POST /api/v5/character/12345678/conditions
  │                                                         │  body: { conditionId: 11 }  ← "poisoned"
  │  relayCommand({ action: "setStatusMarker",              │
  │    tokenId: "tok_abc", marker: "skull", active: true }) │
  │                                                         │
  │  → Roll20 relay fires                                   │
  │  → token.set({ statusmarkers: "skull" })                │
  └─────────────────────────────────────────────────────────┘
  │
  │  Both settled → return result
  ▼
Claude reports:
  {
    character: "Eli",
    damageTaken: 9,
    newHp: 28,
    maxHp: 45,
    conditionsApplied: ["poisoned"],
    roll20Updated: true,
    ddbUpdated: true
  }

  "Eli takes 9 damage, now at 28/45 HP and is poisoned.
   Token HP bar updated in Roll20. D&D Beyond sheet updated."
```

**Total hops:** DM → Claude → MCP Server → DDB API (2 requests) + Roll20 relay (2 relay calls) → both platforms updated

**Note on parallelism:** The Roll20 and DDB updates run in `Promise.all()`. If one fails, the other still completes and the error is reported separately in the tool result — so a DDB network blip doesn't prevent the Roll20 token from updating.
