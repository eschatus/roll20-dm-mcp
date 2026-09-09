> 📖 **roll20-dm-mcp wiki** · [Home](Home) · [Setup](Setup) · [Voice HUD Gem](Voice-HUD-Gem)

# Setup Guide

This system puts an AI assistant at your elbow during D&D 5e sessions on Roll20. It reads your campaign live, tracks combat, and can update tokens, conditions, and initiative on your voice command — while you stay in the story with your players.

This repository is **two MCP servers over Roll20 primitives**:

- **`roll20-dm`** — the live-combat server, over **HTTP** on `127.0.0.1:39200`. HP, conditions, initiative, dice, narration, turn hooks, AoE, zones, the DM inbox. Started with `npm run serve` and kept running during play.
- **`roll20-dm-maps`** — the map-prep server, over **stdio**. Battlemap upload, wall/door detection and placement, page creation, token placement. Started on demand by your MCP client, from `dist/` — so it needs `npm run build`.

Roll20 only. There is **no D&D Beyond** in this repo and **no browser** in it either (#171, #179) — see [What this is not](#what-this-is-not) below.

There are two ways to talk to it:

- **The Gem** (DM Whisper) — a floating overlay with voice push-to-talk and a chat panel. Lives in [its own repository](https://github.com/eschatus/dm-whisper) now.
- **Claude Code** — the Claude CLI, useful for map prep, session setup, and live play alike.

Both connect to the same server. You can run them simultaneously.

---

## What you need

| Requirement | Notes |
|---|---|
| Node.js 20 or later | `node --version` to check (the TypeScript 6 build needs Node 20+) |
| Roll20 Pro or Mentor subscription | Required for the Mod (API) Scripts feature — nothing works without it |
| A Roll20 campaign | Where the Mod script will live (one deploy per campaign) |
| A way to harvest the Roll20 realtime token | Normally the Gem. This server never harvests one — see step 5 |
| Anthropic API key | Only for the maps suite's `analyze_battlemap`. The combat server needs no model key |

---

## What this is not

Three things this repo used to do and no longer does. If you have older notes, they are wrong:

- **No browser.** There is no Playwright dependency, no Chromium to install, no `npx playwright install` step. Nothing here opens a browser window.
- **No D&D Beyond.** The whole DDB bridge — auth, character reads, monster reads — moved to **[beyond-mcp](https://github.com/eschatus/beyond-mcp)**, which the Gem bundles and uses as its lookup backend. There are no `ddb_*` tools here and no DDB credential. `ddbCampaignId` survives in the campaign registry purely as a linkage id passed through to that server.
- **No model call in the combat server.** Tactical planning is decided by the Gem and merely *stored* here (`set_mob_plan` / `get_mob_plans` / `clear_mob_plans`); the turn hook whispers the stored plan to the DM when that token's turn comes up. Player `!`-commands are likewise answered by the Gem — this server just forwards live chat as `chat-message` events on `/events`.

---

## 1. Install

```bash
git clone https://github.com/eschatus/roll20-dm-mcp
cd roll20-dm-mcp
npm install
npm run build
```

`npm run build` is required for `roll20-dm-maps` (which runs `dist/index-maps.js`) and for `npm start`. It is *not* required for `npm run serve`, which runs the HTTP server through `tsx`.

---

## 2. Configure

A `.env` file in the project root is optional — the defaults work. The settings that matter:

| Variable | Default | What it does |
|---|---|---|
| `ROLL20_DATA_DIR` | `./data` | Where credentials and the campaign/character registries live. **Must be the same directory the Gem writes to** (see step 5). |
| `ROLL20_MCP_TOKEN` | auto-generated | Bearer token for the HTTP server. Written for you on first run. |
| `ROLL20_HTTP_PORT` / `ROLL20_HTTP_HOST` | `39200` / `127.0.0.1` | Where the combat server listens. |
| `ANTHROPIC_API_KEY` | — | Only read by the maps suite's `analyze_battlemap`. |
| `ROLL20_CAMPAIGN_ID` / `DDB_CAMPAIGN_ID` | — | Single-campaign fallback if you'd rather not use `register_campaign` / `switch_campaign`. |

You do **not** put a Roll20 password anywhere. The server authenticates with a harvested realtime token (step 5), not credentials.

> `data/` is gitignored and holds live credentials. Keep it out of any cloud-synced folder, and never commit it.

---

## 3. Deploy the Roll20 Mod script

The Mod script is the server's hands inside Roll20. It receives commands from the server and writes changes to your campaign. **Deploying is manual and human-attended** — it means pasting code into a live account's console, which is not something an MCP server or a dev session should do on its own. (The old `npm run release:mod` script and the `deploy_mod_script` tool are gone.)

1. Open your Roll20 campaign
2. Go to **Settings → API Scripts**
3. Click **New Script**
4. Open `mod-scripts/ai-relay.js` from this repo, copy all of it, paste it in
5. Click **Save Script**

**Verify the load, not the save.** A saved script can still fail to start. Check the API Output Console for:

```
[GM_AI_Bridge] Relay script loaded (v2.6.2)
```

The current version is **2.6.2**, and it must match `EXPECTED_RELAY_VERSION` in `src/bridge/relay-version.ts`. A mismatch warns once and shows up in `transport_status`; it never throws, so a stale deploy fails in confusing ways rather than loudly. Check the banner.

**Deploys are per-campaign.** Each Roll20 game carries its own copy of the script, so one campaign can be running an older relay than another. Re-paste after every update to `ai-relay.js`, in every campaign you run.

> **Note:** The script is gated to GM-only senders (`senderIsGM`). Players cannot trigger it.

---

## 4. Start the server

```bash
npm run serve
```

On first run it generates an auth token, writes it to `.env`, and **creates `.mcp.json`** (that file is gitignored, so a fresh clone has none) with a `roll20-dm` and a `roll20-dm-maps` entry, injecting the bearer header into the `roll20-dm` block:

```json
{
  "mcpServers": {
    "roll20-dm": {
      "type": "http",
      "url": "http://127.0.0.1:39200/mcp",
      "headers": { "Authorization": "Bearer <generated token>" }
    },
    "roll20-dm-maps": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/roll20-dm-mcp/dist/index-maps.js"],
      "cwd": "/abs/path/to/roll20-dm-mcp"
    }
  }
}
```

If `.mcp.json` already exists (e.g. you hand-wrote one, or it's a re-run), it only fills in whichever of the `roll20-dm` / `roll20-dm-maps` entries are missing and refreshes the `roll20-dm` bearer header — any other servers you've added stay untouched. You don't need to write this file yourself; just restart Claude Code after the first `npm run serve` to pick it up.

The server runs as long as the terminal stays open. Keep it running during play. Besides `/mcp` it serves `/events`, a bearer-authenticated SSE stream carrying `combat-update`, `mob-plan`, `inbox-item`, `sandbox-status`, `map-ping`, and `chat-message` events; that's how the Gem's HUD and its player-command handling stay in sync.

---

## 5. Furnish the Roll20 credentials

Roll20 access is **furnished, never minted**. The server reads two files out of `ROLL20_DATA_DIR` and, when one is absent, stale, or scoped to the wrong campaign, throws a typed error naming exactly what to refresh — `Roll20TokenUnavailableError` or `Roll20UploadCredentialError`. There is deliberately no browser fallback: a packaged install ships no browser, so a credential failure must surface rather than quietly reach for a Chromium that isn't there.

| File | Shape | Life | Needed for |
|---|---|---|---|
| `roll20-rt-token.json` | `{campaignId, customToken, databaseURL, harvestedAt}` | ~50 min from harvest | Everything. The token is **campaign-scoped** and carries that campaign's RTDB shard. |
| `roll20-upload-cache.json` | `{endpoint, cookies, harvestedAt}` | 8 h | Art upload only (`upload_and_place_map_image`). |

### The supported path — the Gem harvests

The Gem's **Connect Roll20** button opens an Electron window, you sign in normally, and it writes both files. It is first-party session capture in the Gem's own browser (it intercepts Roll20's `signInWithCustomToken` call) — not OAuth, no registered client.

Harvest is **per-campaign**: point the Gem at the campaign you're about to run *before* pressing Connect. A token minted for campaign A cannot read campaign B, and switching campaigns means reconnecting.

> ⚠️ **The data-dir trap.** `ROLL20_DATA_DIR` (this server, default `./data`) and `DMW_DATA_DIR` (the Gem, default `%APPDATA%\DM Whisper` on Windows) must resolve to the **same directory**. If they don't, the Gem harvests into a folder the server never reads — and the two also keep separate campaign registries, so they silently disagree about which campaign is active.

### Without the Gem — the honest gap

If you run this server on its own (plain Claude Code, no Gem), **there is currently no built-in way to obtain a token.** Your two options are to run the Gem once purely to harvest, or to build the file by hand. The manual route works but is fiddly, and the ~50-minute window means you do it right before starting the server.

With the campaign's Roll20 **editor** open in Chrome/Edge:

- **`campaignId`** — the number in the campaign URL.
- **`customToken`** — DevTools → **Network** → filter `signInWithCustomToken` → reload → open the request → **Payload** → copy the `token` field.
- **`databaseURL`** — `https://<ns>.firebaseio.com`, where `<ns>` is the `ns=` query parameter on the editor's `firebaseio.com` **websocket** (Network → WS). Equivalently, read `window.FIREBASE_ROOT` in the Console.
- **`harvestedAt`** — `Date.now()`.

Write those four fields to `<ROLL20_DATA_DIR>/roll20-rt-token.json` and start the server within the window.

Once a connection is established it stays live for the session — the ~50-minute limit governs *making* a connection (server start, campaign switch), not holding one. A mid-session restart means a fresh harvest.

There is no practical hand-built equivalent for `roll20-upload-cache.json`; without it, art upload fails cleanly and nothing else is affected.

---

## 6. Register your campaign

Tell the server which Roll20 campaign to work with.

In Claude Code (set it up via **Track A** below first, so the `roll20-dm` tools are available), run:

```
register_campaign with name "My Campaign", roll20CampaignId "12345678", ddbCampaignId "0"
```

You can find your campaign ID in the Roll20 URL: `roll20.net/campaigns/details/12345678`.

`ddbCampaignId` is required by the schema but inert here — nothing in this repo reads D&D Beyond. Pass your DDB campaign id if you run beyond-mcp alongside (it's the id that links the two), or `"0"` if you don't.

Then `switch_campaign` to make it active. Remember that the realtime token from step 5 is campaign-scoped, so switching campaigns means a fresh harvest.

---

## Track A — Claude Code

Restart Claude Code so it picks up the `.mcp.json` from step 4. After restart, the `roll20-dm` and `roll20-dm-maps` tools will be available.

You can verify this is working by asking Claude: `list_campaigns` or `active_campaign`.

Use Claude Code for map prep, deploying tokens before a session, and anything that doesn't need split-second response at the table. During live play, the Gem is faster — but Claude Code works perfectly well for running combat if you don't have or want the Gem. (Note that without the Gem you'll need the manual token harvest from step 5.)

---

## Track B — The Gem

The Gem is an Electron overlay that floats on your screen. It shows a glowing faceted gem that you hold PTT (push-to-talk) to talk to. An expanded "Scrying Ledger" panel gives you chat, player inbox, and configuration tabs.

> **The Gem lives in its own repository now.** It was split out to
> [`eschatus/dm-whisper`](https://github.com/eschatus/dm-whisper) on 2026-08-11 and is closed
> source; this repository is the MCP server it talks to, and stays open under MIT. Everything in
> Track B happens in that checkout, not this one — including its own setup instructions, which are
> canonical. If you do not have access to it, Track A above is complete on its own.

What matters from *this* side of the relationship:

- The Gem pins this repository as a dependency by tag (currently `#v2.0.3`) and builds it in the clone, so you do not need a separate checkout of roll20-dm-mcp for the Gem to run. Changes here reach the Gem only when it re-pins.
- It bundles `skills/dm-rules.md` and `mod-scripts/ai-relay.js` from this repo into its installer.
- It furnishes the two credential files from step 5, and it is the only supported harvester.
- It consumes the `/events` SSE stream, and it owns the two responsibilities this server gave up: deciding tactical plans (storing them via `set_mob_plan`) and answering player `!`-commands (off `chat-message` events).
- `DMW_DATA_DIR` and `ROLL20_DATA_DIR` must point at the **same** directory, or the Gem and the server keep separate registries and credentials and silently disagree.
- The Gem calls the Anthropic API directly and needs its own `ANTHROPIC_API_KEY`, set in the Gem repo's `.env`. This server does not.

Setup, voice/STT configuration, PTT bindings, and the panel walkthrough all live in the dm-whisper repo.

---

## Verifying everything is connected

With the server running and Claude Code (or the Gem) connected:

1. In Claude Code, ask: `transport_status` — reports this server's build, whether it can reach Roll20, the active campaign, and whether the deployed Mod relay's version matches `EXPECTED_RELAY_VERSION`. Start here; it names most failures outright.
2. Drop a token onto the map and ask: `list_tokens` — your token should appear. That's the combat server round-tripping through the Mod script.
3. If you registered `roll20-dm-maps`, ask: `get_current_page` — should return your current Roll20 page. (`get_current_page` is a maps-suite tool; the combat server doesn't have it.)
4. Say or type to the Gem: `"who's on the map?"` — should list tokens.

If `list_tokens` fails, work down this list:

- **"No usable Roll20 realtime token…"** — the credential from step 5 is missing, older than ~50 minutes, or belongs to another campaign; the message says which. Reconnect Roll20 in the Gem (pointed at *this* campaign), or redo the manual build.
- **Timeout / "sandbox unreachable"** — the Mod script isn't running. Check the campaign's API Output Console for the load banner (step 3) and re-paste if it's absent or the version is stale.
- **Relay version mismatch in `transport_status`** — re-paste `mod-scripts/ai-relay.js` into that campaign.
- **Map tools missing or failing to load** — run `npm run build`; `roll20-dm-maps` runs the compiled `dist/`.
