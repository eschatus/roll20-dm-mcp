# roll20-dm-mcp

MCP server for AI-assisted D&D 5e session management on Roll20. Two servers in one repo:

- **`roll20-dm` (combat)** — real-time combat assistant: HP tracking, conditions, initiative, dice rolls, narration, turn hooks, AoE targeting, zones, and a per-monster tactical AI advisor.
- **`roll20-dm-maps` (maps)** — map prep pipeline: upload battlemaps, auto-place dynamic lighting walls via Claude Vision analysis, token creation. Used between sessions.

Both talk to Roll20 via a Playwright browser session + a deployed Roll20 Mod script (`ai-relay.js`). D&D Beyond is read-only (HP sync, character/monster stat lookups).

## Architecture

```
Claude Code (Claude Sonnet)
    │  MCP tool calls (JSON-RPC over stdio)
    ▼
MCP Server (TypeScript, local process)
    ├──► Anthropic API  (tactical advisor — Haiku / Sonnet / Opus cascade)
    │
    ├──► Playwright → roll20.net  (persistent browser session)
    │         │  !ai-relay {JSON} → Roll20 chat
    │         ▼
    │    Roll20 Mod Script  (mod-scripts/ai-relay.js)
    │    deployed in campaign API editor
    │    ← result whispered back as hidden div, read by MutationObserver
    │
    └──► D&D Beyond  (REST, cobalt cookie auth, read-only)
```

### Browser session sharing

Two MCP server processes share a single browser window. On startup each server tries `connectOverCDP(localhost:9222)` first; if no existing browser is found, it launches a new Playwright persistent context with `--remote-debugging-port=9222`. This eliminates the "profile already in use" error when both servers run simultaneously.

## Setup

```bash
cp .env.example .env
# Fill in: ANTHROPIC_API_KEY, ROLL20_EMAIL, ROLL20_PASSWORD, DDB_EMAIL, DDB_PASSWORD

npm install
npx playwright install chromium
npm run build
```

## MCP server registration

Servers are defined in `.mcp.json` and auto-discovered by Claude Code. No manual setup needed.

| Key | Entry point | Use when |
|---|---|---|
| `roll20-dm` | `dist/index-combat.js` | Running a live session |
| `roll20-dm-maps` | `dist/index-maps.js` | Preparing maps between sessions |

## Deploy the Roll20 Mod script

1. Open your Roll20 campaign → Settings → API Scripts
2. Create a new script, paste `mod-scripts/ai-relay.js`
3. Save — active immediately, no restart needed

The relay receives `!ai-relay {JSON}` commands and whispers results back as hidden divs that a MutationObserver delivers to the MCP server without polling.

## First run

1. Start Claude Code in this directory
2. The first tool call opens a browser window. Log in to Roll20 and D&D Beyond if the session isn't already persisted.
3. Sessions persist to `data/browser-session/` and reuse on restart.

## Claude Code skills

`.claude/commands/` contains slash commands for live sessions:

- `/combat` — session startup: switch campaign, list tokens, enable turn hook, roll initiative, start player inbox loop
- `/round` — parse DM voice narration → auto-roll NPC saves → apply HP/conditions → post styled narration to Roll20 chat

## Tactical Advisor

The tactical advisor (`plan_tactics` / `plan_all_tactics`) generates per-monster turn plans scaled to the creature's Intelligence and Wisdom:

| Tier | Int/Wis avg | Model | Behavior |
|---|---|---|---|
| 0 Feral | ≤5 | Haiku | Pure instinct, one move |
| 1 Dim | ≤8 | Haiku | Basic predatory logic |
| 2 Average | ≤11 | Sonnet | Reads the battlefield |
| 3 Sharp | ≤15 | Sonnet + thinking | Coordinates with allies |
| 4 Brilliant | ≤20 | Sonnet + extended thinking | Short + medium-term cascade |
| 5 Mastermind | 21+ | Opus + extended thinking | Full 3-stage strategic cascade |

**Context injected per plan:**
- Monster abilities (from Roll20 character sheet `npcaction` repeating section, or DDB compendium fallback)
- Tactical doctrine (Ammann *flee, Mortal, flee* excerpts, keyed by creature type)
- Battlefield: nearby enemies with HP status and range band (`adjacent / near / mid / far / distant`), plus nearby allies for all tiers
- Tactical memory: what the creature did in prior rounds
- DM notes: freeform context injected per encounter

**Awareness radius:** 60ft base (Wis modifier adjusts ±15ft per point above/below 10). Suited for outdoor encounters; creatures with darkvision see the full radius in darkness.

**Output:** single-line whisper to GM only (`/w gm`) using bold Markdown labels:
```
🧠 Wolf the Scarred — **Move:** Close on Dante · **Action:** Bite · **Note:** Pack Tactics needs ally adjacent
```

**Turn hook integration:** plans are whispered to GM automatically when the initiative tracker advances to each mob's turn. `plan_all_tactics` is called automatically at combat start and round start.

**Debug mode:** `plan_tactics tokenId=X debug=true postToChat=false` returns the full `baseContext`, complete `prompt`, and `rawResponse` for inspection.

## Combat workflow

1. DM narrates what happened (voice-to-text or typed)
2. `/round` parses it: finds AoE templates on the map, auto-rolls NPC saves, applies damage/conditions
3. Claude proposes a numbered action list with before/after HP, executes on confirmation
4. Two Roll20 chat posts: atmospheric narration (`style=narration`) + bulleted mechanic summary (`style=combat`) — no exact HP numbers visible to players, only ASCII bar + Wounded marker
5. Session state snapshot written to memory after each round

## Key design decisions

**D&D Beyond is read-only.** DDB condition writes return 405. HP is tracked on Roll20 tokens; spell slots are tracked in session state snapshots. DDB is polled at round start to spot-check drift against tracked values.

**AoE templates are pre-placed.** Players drop a cone/circle marker before the DM narrates. The relay finds it via `list_tokens`, renames it to the spell, uses `find_tokens_in_range` for targeting, then removes it (one-shot spells) or moves it to the map layer (persistent effects like Web or Cloudkill).

**Conditions use `Name::id` marker format.** e.g. `Wounded::4444333`. Applied and removed via `batch_exec` for speed — single relay round-trip for multi-token updates.

**Zones go on the map layer.** Spell areas drawn by `create_zone` land on Roll20's map layer so tokens always render above them. Auras (Spirit Guardians, etc.) use token `aura1_radius` instead.

**Duplicate token epithets.** Tokens with the same name get epithets at initiative roll time (`Wolf the Scarred`, `Wolf the Gaunt`) — assigned from monster-type word banks, stored in the token name and tooltip. Epithets use a space separator; Roll20 nameplates do not support multi-line text.

**Tactical data cached in gmnotes.** Monster ability scores and action text are written to the token's `gmnotes` field on first plan, keyed by `TACDATA:`. Subsequent plans skip the DDB lookup — survives MCP server restarts.
