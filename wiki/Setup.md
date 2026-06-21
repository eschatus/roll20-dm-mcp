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
ROLL20_EMAIL=your@email.com
ROLL20_PASSWORD=yourpassword
ANTHROPIC_API_KEY=sk-ant-...   # only needed for the Gem
```

If you use D&D Beyond:

```
DDB_EMAIL=your@email.com
DDB_PASSWORD=yourpassword
```

The `BROWSER_USER_DATA_DIR` path is where your Roll20 and DDB login sessions are stored on disk. The default (`./data/browser-session`) works fine, but keep it outside any cloud-synced folder — it holds live session cookies.

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

When the server starts it opens a persistent Playwright browser in the background. This browser is how the server sends commands to Roll20.

By default this browser sits minimized in the taskbar (`DMW_BROWSER_HIDE=0` in `.env` keeps it on screen). When a login is needed it automatically un-minimizes so you can sign in.

On first run (or if your session has expired) you need to log in manually:

1. The browser window pops to the foreground. Navigate to `roll20.net` and sign in.
2. If you use D&D Beyond, also navigate to `dndbeyond.com` and sign in.
3. Once logged in, the browser can stay in the background — you do not need to interact with it again.

Your session is saved to `BROWSER_USER_DATA_DIR` so you only need to do this once per session expiry (typically weeks or months).

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

### Voice — optional

If you want voice (push-to-talk), you need the Whisper STT sidecar. If you don't want voice, you can skip this section and type into the Gem's Chat tab instead.

**With a GPU (NVIDIA, CUDA-capable):**

1. Install Python 3.10 if you don't have it (`py -3.10 --version` to check)
2. Set up the sidecar venv:

```bash
cd voice-hud/stt
py -3.10 -m venv .venv
.venv\Scripts\python -m pip install -U pip
.venv\Scripts\python -m pip install -r requirements.txt
```

That's it — the Gem will find and start the sidecar automatically on next launch. The default model (`large-v3-turbo` at float16, ~3 GB VRAM) gives excellent accuracy. If you're tight on VRAM, set in the Gem's Config tab: model `medium`, compute type `int8`.

**Without a GPU (CPU-only):**

Follow the same steps but skip the CUDA packages — the sidecar will run on CPU using a small model. In the Gem's Config tab, set:

- Device: `cpu`
- Model: `small`
- Compute type: `int8`

Transcription will be noticeably slower than on GPU (a few seconds per utterance instead of near-instant), but it works reliably. For fast-paced combat, you may prefer to type.

**PTT key:** The default is `Right Ctrl` (hold to speak, release to send). Change it in the Gem's Config tab if needed. The confirm key (for write proposals) defaults to `Right Shift`.

---

## Verifying everything is connected

With the server running and Claude Code (or the Gem) connected:

1. In Claude Code, ask: `get_current_page` — should return your current Roll20 page
2. Roll a token onto the map and ask: `list_tokens` — your token should appear
3. Say or type to the Gem: `"who's on the map?"` — should list tokens

If `get_current_page` fails, the Roll20 relay isn't reaching the Mod. Double-check that the script is saved and your Roll20 campaign is open.

If the DDB tools return errors, the cached DDB session cookie has likely expired — re-login to D&D Beyond in the background browser (see step 5) to refresh it. (DDB reads run browserlessly from that cookie; the browser is only needed to (re)harvest it.)
