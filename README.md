# roll20-dm-mcp

AI-assisted D&D 5e session management for Roll20 + D&D Beyond. Three components:

- **`roll20-dm` MCP server** — live combat assistant over HTTP: HP tracking, conditions, initiative, dice, narration, turn hooks, AoE targeting, zones, tactical AI advisor, DDB character/monster reads.
- **`roll20-dm-maps` MCP server** — map prep pipeline (stdio): upload battlemaps, auto-place dynamic lighting walls via Claude Vision, token creation.
- **Voice HUD** (`voice-hud/`) — transparent Electron overlay: push-to-talk → Whisper STT → Claude agent → live tabletop. The DM speaks; the gem acts.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Voice HUD (Electron)                               │
│  PTT → Whisper STT → Claude Haiku agent             │
│  transparent gem overlay, always on top             │
└────────────────────┬────────────────────────────────┘
                     │ HTTP MCP (bearer auth, port 39200)
┌────────────────────▼────────────────────────────────┐
│  roll20-dm MCP server (HTTP, src/index-http.ts)     │
│                                                     │
│  ┌── RT transport (default) ──────────────────┐     │
│  │  Firebase RTDB direct reads (~50ms warm)   │     │
│  │  signInWithCustomToken (harvested once,     │     │
│  │  cached to data/roll20-rt-token.json)       │     │
│  └────────────────────────────────────────────┘     │
│                                                     │
│  ┌── Mod relay (writes + fallback) ───────────┐     │
│  │  Playwright → roll20.net                   │     │
│  │  !ai-relay {JSON} → Roll20 chat            │     │
│  │  ← result via MutationObserver             │     │
│  └────────────────────────────────────────────┘     │
│                                                     │
│  ┌── D&D Beyond (browserless) ────────────────┐     │
│  │  CobaltSession cookie → JWT (ttl 300s)     │     │
│  │  character-service / monster-service       │     │
│  │  plain fetch, no browser needed            │     │
│  └────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────┘

Claude Code (separate MCP client, same server)
  └── map prep, session setup, /combat, /round skills
```

### Transport layers

| Layer | Read latency | Write latency | When used |
|---|---|---|---|
| RT (Firebase RTDB) | ~50ms warm | — | Token reads, turn order, page state |
| Mod relay (Playwright) | 3–4s | 3–4s | All writes; read fallback if RT unavailable |
| DDB REST | ~200ms | — | Character sheets, monster stats, campaign roster |

The browser window opens only for the initial RT token harvest and for write-relay commands. It closes automatically after token harvest and reopens on demand.

## Setup

```bash
cp .env.example .env
# Required: ANTHROPIC_API_KEY, ROLL20_EMAIL, ROLL20_PASSWORD
# Optional: DDB_COBALT (skip browser harvest), ROLL20_MCP_TOKEN (auto-generated if absent)

npm install
npx playwright install chromium
npm run build
```

### First run

```bash
npm run serve          # starts roll20-dm HTTP server on port 39200
```

On first run with no `ROLL20_MCP_TOKEN` in `.env`, the server auto-generates a token, writes it to `.env`, and updates `.mcp.json` with the bearer header. Restart Claude Code once to pick up the new header.

`.mcp.json` is gitignored — it contains the live bearer token and is regenerated automatically.

## MCP server registration

Servers are defined in `.mcp.json` (gitignored, auto-managed):

| Key | Transport | Entry point | Use when |
|---|---|---|---|
| `roll20-dm` | HTTP (port 39200) | `src/index-http.ts` (`npm run serve`) | Live session or Voice HUD |
| `roll20-dm-maps` | stdio | `dist/index-maps.js` | Map prep between sessions |

## Deploy the Roll20 Mod script

1. Open your Roll20 campaign → Settings → API Scripts
2. Create a new script, paste `mod-scripts/ai-relay.js`
3. Save — active immediately, no restart needed

The relay receives `!ai-relay {JSON}` commands and whispers results back as hidden divs read by a MutationObserver in the Playwright session.

## Voice HUD

The scrying gem — a transparent cushion-cut crystal overlay that floats above Roll20 in the corner of the screen.

```bash
cd voice-hud
npm install
npm run start          # builds + launches Electron
```

**Controls:**
- Hold **Right Ctrl** → speak → release to send (configurable via `DMW_PTT_KEY`)
- **Right Shift** to confirm a proposed write action
- **Esc** to cancel
- Click the ✥ handle to drag the gem
- Click the ✦ icon to open the Scrying Ledger (full panel with Chat, Config, Debug tabs)

**Agent:** defaults to Anthropic cloud (Claude Haiku). Brain buttons in the Chat tab switch between local Ollama and cloud; selection persists across restarts.

**STT:** faster-whisper `large-v3-turbo` on CUDA. Character names, nicknames, and campaign vocab are injected as `initial_prompt` for every transcription, updated after each agent turn.

**Config:** all runtime knobs (PTT key, STT model, MCP URL, provider, etc.) are exposed in the Scrying Ledger Config tab and persisted to `voice-hud/.env`.

**Debug:** the Scrying Ledger Debug tab streams the main process `console.error` log live, with 500-entry history.

## Campaign context

`data/campaign-context.json` is the shared source of truth for per-campaign vocab, nickname aliases, and DM notes. Both the MCP server tools (`add_vocab`, `add_nickname`, `set_campaign_notes`) and the Voice HUD wizard panel read and write this file. The agent can extend it at any time via tool calls.

## Claude Code skills

`.claude/commands/` contains slash commands for live sessions:

- `/combat` — session startup: switch campaign, list tokens, enable turn hook, roll NPC initiative, arm player inbox loop, plan all tactics
- `/round` — parse DM narration → propose action list (HP changes, conditions, narration) → execute on confirmation

## Tactical Advisor

`plan_tactics` / `plan_all_tactics` generates per-monster turn plans scaled to creature Intelligence and Wisdom. Called automatically at combat start and at the top of each round (both from the `/combat` skill and the Voice HUD agent).

| Tier | Int/Wis avg | Model | Behavior |
|---|---|---|---|
| 0 Feral | ≤5 | Haiku | Pure instinct |
| 1 Dim | ≤8 | Haiku | Basic predatory logic |
| 2 Average | ≤11 | Sonnet | Reads the battlefield |
| 3 Sharp | ≤15 | Sonnet + thinking | Coordinates with allies |
| 4 Brilliant | ≤20 | Sonnet + extended thinking | Short + medium-term planning |
| 5 Mastermind | 21+ | Opus + extended thinking | Full 3-stage strategic cascade |

Plans are whispered GM-only and surfaced again automatically when the initiative tracker reaches each mob's turn.

## Key design decisions

**RT transport reads Roll20 state directly.** Firebase RTDB token is harvested once via browser (intercepting `signInWithCustomToken`), cached to `data/roll20-rt-token.json`, and reused for all subsequent reads. Writes still go through the Mod relay (guaranteed server-side propagation).

**D&D Beyond is fully browserless.** `CobaltSession` cookie is harvested once and cached to `data/ddb-cobalt.json`. Every DDB read thereafter is a plain HTTPS fetch via `character-service` or `monster-service` — no Chromium involved.

**D&D Beyond is read-only.** HP and conditions are tracked on Roll20 tokens. DDB is polled for character state (HP, conditions, stats) but never written to.

**PC initiative is read-only.** `roll_initiative` always uses `npcOnly=true`. Players set their own initiative; the Mod never touches PC entries.

**Turn order writes wipe player entries.** The relay never calls `setTurnOrder` wholesale. NPCs are added via `roll_initiative npcOnly=true clearFirst=false`; single entries adjusted via `update_turn_order`.

**AoE emanations use token auras; fixed areas use zones.** Spirit Guardians, Aura of Protection, etc. → `set_token_props aura1_radius`. Fireball, Web, Cloudkill → `create_zone` on the map layer.

**Duplicate token epithets.** Tokens sharing a name get epithets at initiative roll time (`Wolf the Scarred`, `Wolf the Gaunt`) — assigned from creature-type word banks, stored in the token name.

**Tactical data cached in gmnotes.** Monster ability scores and action text are written to `gmnotes` on first plan under `TACDATA:`. Subsequent plans skip the DDB lookup — survives MCP server restarts.

**Shared campaign context.** `data/campaign-context.json` is written by the MCP server tools, the Voice HUD wizard, and the agent's `add_vocab`/`add_nickname` calls — one file, no sync needed.
