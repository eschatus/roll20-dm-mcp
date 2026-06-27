> 📖 **roll20-dm-mcp wiki** · [Home](Home) · [Setup](Setup) · [Voice HUD Gem](Voice-HUD-Gem) · [Player Commands](Player-Commands)

# Setup Guide

This system puts an AI assistant at your elbow during D&D 5e sessions on Roll20. It reads your campaign live, tracks combat, and can update tokens, conditions, and initiative on your voice command — while you stay in the story with your players.

There are two ways to talk to it:

- **The Gem** — a floating overlay on your screen with voice push-to-talk and a chat panel (requires an Anthropic API key)
- **Claude Code** — the Claude CLI, useful for map prep, session setup, and anything you don't need during live play

Both connect to the same server. You can run them simultaneously.

---

## What you need

| Requirement | Notes |
|---|---|
| Node.js 20 or later | `node --version` to check (the TypeScript 6 build needs Node 20+) |
| Roll20 Pro or Mentor subscription | Required for the Mod (API) Scripts feature |
| A Roll20 campaign | Where the Mod script will live |
| D&D Beyond account | Optional — only needed for DDB stat lookups |
| Anthropic API key | Required for the Gem; not required for Claude Code |

---

## 1. Install

```bash
git clone https://github.com/your-repo/roll20-dm-mcp
cd roll20-dm-mcp
npm install
npm run build
```

---

## 2. Configure

Copy the example env file and fill it in:

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

```
ANTHROPIC_API_KEY=sk-ant-...   # only needed for the Gem
```

You do **not** need to put your Roll20 or D&D Beyond passwords in `.env`. The server reaches Roll20 over the realtime (RT) transport using a token it harvests when you sign in through the browser once (step 5); D&D Beyond reads use a `CobaltSession` cookie harvested the same way. You can pre-seed the DDB cookie by setting `DDB_COBALT` directly if you'd rather skip that harvest.

The `BROWSER_USER_DATA_DIR` path is where your one-time Roll20 and DDB login sessions are stored on disk. The default (`./data/browser-session`) works fine, but keep it outside any cloud-synced folder — it holds live session cookies.

---

## 3. Deploy the Roll20 Mod script

The Mod script is the server's hands inside Roll20. It receives commands from the server and writes changes to your campaign.

1. Open your Roll20 campaign
2. Go to **Settings → API Scripts**
3. Click **New Script**
4. Open `mod-scripts/ai-relay.js` from this repo, copy all of it, paste it in
5. Click **Save Script**

The script activates immediately. You do not need to restart Roll20.

> **Note:** The script is gated to GM-only senders. Players cannot trigger it.

---

## 4. Start the server

```bash
npm run serve
```

On first run it generates an auth token, writes it to `.env`, and injects it into `.mcp.json` so Claude Code can find the server. You'll see a message in the terminal when this happens.

The server runs as long as the terminal stays open. Keep it running during play.

---

## 5. Log into Roll20 and D&D Beyond

By default the server talks to Roll20 **browserlessly** over the realtime (RT) transport — it does not need a browser open to send commands during play. The persistent Playwright browser exists only to **harvest credentials once** (the Roll20 RT token and, if you use it, the D&D Beyond `CobaltSession` cookie) and as a fallback if RT is unavailable.

By default this browser sits minimized in the taskbar (`DMW_BROWSER_HIDE=0` in `.env` keeps it on screen). When a login is needed it automatically un-minimizes so you can sign in.

On first run (or if a harvested token/cookie has expired) you need to log in manually:

1. The browser window pops to the foreground. Navigate to `roll20.net` and sign in — the server intercepts Roll20's sign-in token and caches it to `data/roll20-rt-token.json`.
2. If you use D&D Beyond, also navigate to `dndbeyond.com` and sign in — the `CobaltSession` cookie is cached to `data/ddb-cobalt.json`. (You can skip this harvest by setting `DDB_COBALT` in `.env` directly.)
3. Once the token/cookie are cached, the browser can stay in the background — RT carries reads and writes from then on, and you do not need to interact with it again.

The harvested credentials are reused until they expire (typically weeks or months), so you only need to do this once per expiry.

---

## 6. Register your campaign

Tell the server which Roll20 campaign to work with.

In Claude Code (set it up via **Track A** below first, so the `roll20-dm` tools are available), run:

```
register_campaign with name "My Campaign", roll20CampaignId "12345678"
```

You can find your campaign ID in the Roll20 URL: `roll20.net/campaigns/details/12345678`.

If you also use D&D Beyond, include `ddbCampaignId` to enable stat lookups.

---

## Track A — Claude Code

Restart Claude Code so it picks up the `.mcp.json` update from step 4. After restart, the `roll20-dm` tools will be available.

You can verify this is working by asking Claude: `list_campaigns` or `active_campaign`.

Use Claude Code for map prep, deploying tokens before a session, and anything that doesn't need split-second response at the table. During live play, the Gem is faster — but Claude Code works perfectly well for running combat if you don't have or want the Gem.

---

## Track B — The Gem

The Gem is an Electron overlay that floats on your screen. It shows a glowing faceted gem that you hold PTT (push-to-talk) to talk to. An expanded "Scrying Ledger" panel gives you chat, player inbox, and configuration tabs.

### Install the Gem

```bash
cd voice-hud
npm install
```

### Anthropic API key

The Gem calls the Anthropic API directly. Make sure `ANTHROPIC_API_KEY` is set in the root `.env` (the Gem reads the root `.env` automatically).

### Start the Gem

```bash
cd voice-hud
npm start
```

The gem window appears on screen. It starts in ghost mode (dim, transparent) and comes alive when you hold the PTT key.

### Voice — works out of the box

Voice (push-to-talk) works with **no extra setup**. The Gem ships a bundled whisper.cpp resident STT server (`whisper-server.exe` + the `ggml-base.en.bin` model) — no Python, no venv, no downloads. `npm start` launches it automatically. If you don't want voice, you can ignore it and type into the Gem's Chat tab instead.

**Default (CPU):** the bundled `ggml-base.en.bin` model gives good accuracy and runs on CPU. Nothing to install.

**GPU (NVIDIA CUDA / Vulkan):** drop in a cuBLAS or Vulkan build of `whisper-server` and point the Gem at it with `DMW_WHISPER_BIN` (or `DMW_WHISPER_SERVER_BIN`) in `.env`. No code change needed — it's a drop-in binary swap. For higher accuracy on a capable GPU you can also point `DMW_WHISPER_MODEL` at a larger ggml model (e.g. `ggml-medium.en.bin` or `ggml-large-v3.bin`).

**Deprecated alternative — Python faster-whisper:** the old Python faster-whisper sidecar is mothballed (#46) and not required by anything. If you specifically want it, opt in with `DMW_STT_ENGINE=faster-whisper` and install its venv (`voice-hud/stt/requirements.txt`). The bundled whisper.cpp server is the supported path.

**PTT key:** The default is `Right Ctrl` (hold to speak, release to send). Change it in the Gem's Config tab if needed. The confirm key (for write proposals) defaults to `Right Shift`.

---

## Verifying everything is connected

With the server running and Claude Code (or the Gem) connected:

1. In Claude Code, ask: `get_current_page` — should return your current Roll20 page
2. Roll a token onto the map and ask: `list_tokens` — your token should appear
3. Say or type to the Gem: `"who's on the map?"` — should list tokens

If `get_current_page` fails, the Roll20 relay isn't reaching the Mod. Double-check that the script is saved and your Roll20 campaign is open.

If the DDB tools return errors, the cached DDB session cookie has likely expired — re-login to D&D Beyond in the background browser (see step 5) to refresh it. (DDB reads run browserlessly from that cookie; the browser is only needed to (re)harvest it.)
