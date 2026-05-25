# roll20-dm-mcp

MCP server for AI-assisted D&D session management. Two servers in one repo:

- **`roll20-dm` (combat)** — real-time combat assistant: HP tracking, conditions, dice rolls, narration, turn hooks, AoE targeting, zones. Used during live sessions.
- **`roll20-dm-maps` (maps)** — map prep pipeline: upload battlemaps, auto-place dynamic lighting walls via Claude Vision analysis, token creation. Used between sessions.

Both talk to Roll20 via a Playwright browser session + a deployed Roll20 Mod script (`ai-relay.js`). D&D Beyond is read-only (HP sync via `ddb_update_hp`; condition writes are unsupported by their API).

## Architecture

```
Claude Code (Claude Sonnet / Haiku)
    │  MCP tool calls (JSON-RPC over stdio)
    ▼
MCP Server (TypeScript, local process)
    ├──► Playwright → roll20.net (browser session)
    │         │  !ai-relay {JSON} → Roll20 chat
    │         ▼
    │    Roll20 Mod Script (ai-relay.js)
    │    deployed in campaign API editor
    │    ← result whispered back as hidden div
    │
    └──► D&D Beyond (REST, cobalt cookie, read-heavy)
```

## Setup

```bash
cp .env.example .env
# Fill in ROLL20_EMAIL, ROLL20_PASSWORD, DDB_EMAIL, DDB_PASSWORD

npm install
npx playwright install chromium
npm run build
```

## MCP server registration

Servers are defined in `.mcp.json` at the project root and auto-discovered by Claude Code. No manual `claude mcp add` needed — just open the project.

Two servers run independently:

| Key in .mcp.json | Entry point | Use when |
|---|---|---|
| `roll20-dm` | `dist/index-combat.js` | Running a session |
| `roll20-dm-maps` | `dist/index-maps.js` | Preparing maps |

## Deploy the Roll20 Mod script

1. Open your Roll20 campaign → Settings → API Scripts
2. Create a new script, paste the contents of `mod-scripts/ai-relay.js`
3. Save — the relay is active immediately (no restart needed)

The relay receives `!ai-relay {JSON}` commands from the MCP server via the Playwright browser session and whispers results back as hidden divs that Playwright polls.

## First run

1. Start Claude Code in this directory
2. The first tool call opens a browser window (headless: false). Log in to Roll20 and D&D Beyond if the session isn't already persisted
3. Sessions are saved to `data/browser-session/` and reused on restart

## Claude Code skills

The `.claude/commands/` directory contains slash commands for live sessions:

- `/combat` — session startup: switch campaign, check hook, load combat state
- `/round` — parse DM voice narration → apply HP/conditions → post styled narration to Roll20 chat

## Combat workflow

1. DM narrates what happened (voice-to-text or typed)
2. `/round` parses it: finds AoE templates on the map, auto-rolls NPC saves, applies damage/conditions
3. Claude proposes an action list, executes on confirmation
4. Two Roll20 chat posts: atmospheric narration + bulleted mechanic summary (no exact HP — ASCII bar + Wounded marker only)
5. Session state snapshot written to memory after each round

## Key design decisions

**D&D Beyond is read-only.** DDB condition writes return 405. HP is tracked on Roll20 tokens; spell slots are tracked in session state. DDB is polled at round start to spot-check drift.

**AoE templates are pre-placed.** Players drop a cone/circle marker before the DM narrates. The relay finds it via `list_tokens`, renames it to the spell, uses `find_tokens_in_range` for targeting, then removes it (one-shot) or moves it to the map layer (persistent).

**Conditions use `set_token_marker` directly.** The `Name::id` format (e.g. `Wounded::4444333`) is required for custom campaign markers. Apply/remove goes through `batch_exec` for speed.

**Zones go on the map layer.** Spell areas drawn by `create_zone` land on Roll20's map layer so tokens always render above them.

**Epithet nameplates.** Duplicate tokens get epithets assigned at initiative roll time (`Zombie\nthe Shambling`) — the `\n` makes them stack in the Roll20 nameplate.
