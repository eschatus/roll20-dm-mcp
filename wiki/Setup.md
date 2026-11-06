> 📖 **roll20-dm-mcp wiki** · [Home](Home) · [Setup](Setup) · [Voice HUD Gem](Voice-HUD-Gem)

# Setup Guide

This system puts an AI assistant at your elbow during D&D 5e sessions on Roll20. It reads your campaign live, tracks combat, and can update tokens, conditions, and initiative on your voice command — while you stay in the story with your players.

This repository is **two MCP servers over Roll20 primitives**:

- **`roll20-dm`** — the live-combat server, over **HTTP** on `127.0.0.1:39200`. HP, conditions, initiative, dice, narration, turn hooks, AoE, zones, the DM inbox. Started with `npm run serve` and kept running during play.
- **`roll20-dm-maps`** — the map-prep server, over **stdio**. Battlemap upload, wall/door detection and placement, page creation, token placement. Started on demand by your MCP client, from `dist/` — so it needs `npm run build`.

Roll20 only. There is **no D&D Beyond** in this repo and **no browser** in it either (#171, #179) — see [What this is not](#what-this-is-not) below.

You talk to it through any MCP client. **Claude Code** works for map prep, session setup and live play. For voice at the table there is an optional separate app, [the Gem](https://github.com/eschatus/dm-whisper) (see the end of this guide). Both connect to the same server, and you can run them together.

---

## What you need

| Requirement | Notes |
|---|---|
| Node.js 20 or later | `node --version` to check (the TypeScript 6 build needs Node 20+) |
| Roll20 Pro or Mentor subscription | Required for the Mod (API) Scripts feature — nothing works without it |
| A Roll20 campaign | Where the Mod script will live (one deploy per campaign) |
| A logged-in Chrome or Edge | One paste to furnish the Roll20 token. The server itself never opens a browser — see step 5 |
| Anthropic API key | Only for the maps suite's `analyze_battlemap`. The combat server needs no model key |

---

## What this is not

Three things this repo used to do and no longer does. If you have older notes, they are wrong:

- **No browser.** There is no Playwright dependency, no Chromium to install, no `npx playwright install` step. Nothing here opens a browser window.
- **No D&D Beyond.** The whole DDB bridge — auth, character reads, monster reads — moved to **[beyond-mcp](https://github.com/eschatus/beyond-mcp)**, a separate server. There are no `ddb_*` tools here, no DDB credential, and no DDB ids in the campaign registry.
- **No model call in the combat server.** Tactical planning is decided by your client and merely *stored* here (`set_mob_plan` / `get_mob_plans` / `clear_mob_plans`); the turn hook whispers the stored plan to the DM when that token's turn comes up. Player `!`-commands are likewise answered by your client — this server just forwards live chat as `chat-message` events on `/events`.

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
| `ROLL20_DATA_DIR` | `./data` | Where credentials and the campaign/character registries live. If you run the Gem, this must be the directory it writes to (see step 5). |
| `ROLL20_RT_TOKEN` | *(unset)* | The realtime credential inline — the same `{campaignId, customToken or refreshToken, databaseURL, harvestedAt}` object as a stored token. A single override: it wins over every stored token, and malformed or wrong-campaign fails loudly rather than falling back to one. |
| `ROLL20_MCP_TOKEN` | auto-generated | Bearer token for the HTTP server. Written for you on first run. |
| `ROLL20_HTTP_PORT` / `ROLL20_HTTP_HOST` | `39200` / `127.0.0.1` | Where the combat server listens. |
| `ANTHROPIC_API_KEY` | — | Only read by the maps suite's `analyze_battlemap`. |
| `ROLL20_CAMPAIGN_ID` | — | Single-campaign fallback if you'd rather not use `register_campaign` / `switch_campaign`. |

You do **not** put a Roll20 password anywhere. The server authenticates with a harvested realtime token (step 5), not credentials.

> `data/` is gitignored and holds live credentials. Keep it out of any cloud-synced folder, and never commit it.

---

## 3. Deploy the Roll20 Mod script

The Mod script is the server's hands inside Roll20. It receives commands from the server and writes changes to your campaign. **Deploying is manual and human-attended** — it means pasting code into a live account's console, which is not something an MCP server or a dev session should do on its own. (The old `npm run release:mod` script and the `deploy_mod_script` tool are gone.)

1. Open your Roll20 campaign
2. Go to **Settings → API Scripts**
3. Click **New Script**
4. Run `npm run build:mod` in this repo, then open `mod-scripts/.ai-relay.deploy.js`, copy all of it, paste it in
5. Click **Save Script**

`build:mod` minifies `mod-scripts/ai-relay.js` (~156KB of code and comments) down to ~63KB, which is what fits the Mod editor comfortably; it fails the build rather than emitting a script that would not parse, and `npm run build:mod -- --verify` additionally runs the emulator suite against the minified bytes. Pasting `mod-scripts/ai-relay.js` itself works too — it is what the DM Whisper gem pastes; the minified artifact is the same relay, just smaller, and prints the same load banner.

**Verify the load, not the save.** A saved script can still fail to start. Check the API Output Console for:

```
[GM_AI_Bridge] Relay script loaded (v2.12.1)
```

The current version is **2.12.1**, and it must match `EXPECTED_RELAY_VERSION` in `src/bridge/relay-version.ts`. A mismatch warns once and shows up in `transport_status`; it never throws, so a stale deploy fails in confusing ways rather than loudly. Check the banner.

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

Roll20 access is **furnished, never minted**. The server reads two files out of `ROLL20_DATA_DIR` and, when one is absent, stale, or scoped to the wrong campaign, throws a typed error naming exactly what to refresh — `Roll20TokenUnavailableError` or `Roll20UploadCredentialError`. Nothing here opens a browser: you do the copying, and `npm run furnish:token` validates and writes.

| File | Shape | Life | Needed for |
|---|---|---|---|
| `rt-tokens/<campaignId>.json` (one per campaign) | `{campaignId, customToken or refreshToken, databaseURL, harvestedAt}` | `refreshToken`: until revoked, lifespan unknown. `customToken`: ~1 h from harvest. Firebase decides, not us | Everything. The token is **campaign-scoped** and carries that campaign's RTDB shard. |
| `roll20-upload-cache.json` | `{cookies, userAgent, harvestedAt}` | 8 h | Art upload only (`upload_and_place_map_image`, `batch_import_maps`, `upload_image`). |

You must be a **GM** of the campaign, and the campaign needs the relay Mod installed (§3) — which in turn needs the campaign creator's Pro subscription.

### The token

Open **only that campaign's editor** (the play screen, not the details page) in Chrome or Edge. An open game can stop another one launching, and one file holds one campaign. Then, in the project folder:

```powershell
npm run furnish:token
```

1. It prints a line and copies it to your clipboard where it can. Press **F12** in the editor, and paste the line into the **Console**.
2. A popup appears with the text selected. Press **Ctrl+C**, then **Enter**.
3. Paste into the waiting terminal and press Enter. Nothing shows as you paste.

It checks that this is a **GM** login, reads the campaign from the login itself, confirms the database holds that campaign, and writes `<ROLL20_DATA_DIR>/rt-tokens/<campaignId>.json`, leaving every other campaign's token alone. Add `--print` to get the JSON for `ROLL20_RT_TOKEN` instead (it overrides the stored tokens; handy for a stdio `roll20-dm-maps` or a script with no shared data dir). Each campaign you run needs this once, and after that `switch_campaign` picks that campaign's token by itself. An older `roll20-rt-token.json` is copied into the slot for the campaign it holds the first time the server reads a token.

That stores a **refresh token**, so server restarts need no new capture. It kept working after a Roll20 sign-out and with the browser closed, so **treat it like a password**: keep it out of chats, and know that you currently can't revoke it yourself. See `docs/security.md`.

### Art upload

Only needed to upload map art. The cookies last 8 hours here, and page scripts can't read them, so this one is a copied request. With the editor open and you logged in:

1. Press **F12**, open the **Network** tab, and reload the page.
2. Right-click the **top** request (named like `editor/`) → **Copy → Copy as cURL**. If Chrome offers two, pick **(bash)**.
3. In the project folder:

```powershell
Get-Clipboard | npm run furnish:token -- --upload
```

On macOS use `pbpaste |`. Without this file, art upload fails cleanly and nothing else is affected, and you can upload map art through Roll20's own UI.

### A one-hour token instead

If you'd rather not store a long-lived login, you can furnish the one-shot custom token. The server must connect within about an hour of minting, and a restart means doing this again.

1. In the editor's **Console**, run:

   ```js
   indexedDB.deleteDatabase("firebaseLocalStorageDb"); window.FIREBASE_ROOT
   ```

   Note what it prints (e.g. `https://roll20-99913.firebaseio.com`). The `deleteDatabase` matters: Roll20 normally restores its login from that cache on reload and **never sends the token**, so without it step 2 shows nothing.
2. Switch to the **Network** tab, tick **Preserve log**, type `signInWithCustomToken` in the filter box, and **reload** the page.
3. Right-click the request that appears → **Copy → Copy as cURL** (or open it → **Payload** and copy the `token` value).

Then, within a few minutes, in the project folder:

```powershell
Get-Clipboard | npm run furnish:token -- --campaign <campaignId> --db <what step 1 printed>
```

`<campaignId>` is the number in the campaign's URL (`/campaigns/details/1234567`, `/join/1234567/…`). On macOS use `pbpaste |`. A connected server stays connected: the hour governs *making* a connection, not holding one, and `transport_status` shows the token's age under `rtToken`.

### If you run the Gem

The Gem harvests both files itself with its **Connect Roll20** button, so you don't need the commands above. Harvest is per-campaign: point the Gem at the campaign you're about to run first.

> ⚠️ **The data-dir trap.** `ROLL20_DATA_DIR` (this server, default `./data`) and `DMW_DATA_DIR` (the Gem, default `%APPDATA%\DM Whisper` on Windows) must resolve to the **same directory**. If they don't, the Gem harvests into a folder the server never reads, and the two keep separate campaign registries, so they silently disagree about which campaign is active.

Don't furnish a refresh token into the Gem's data dir yet: the Gem treats the file as stale after 40 minutes and overwrites it with a custom token.

---

## 6. Register your campaign

Tell the server which Roll20 campaign to work with.

In Claude Code (set it up via **Track A** below first, so the `roll20-dm` tools are available), run:

```
register_campaign with name "My Campaign", roll20CampaignId "12345678"
```

You can find your campaign ID in the Roll20 URL: `roll20.net/campaigns/details/12345678`.

Then `switch_campaign` to make it active. Remember that the realtime token from step 5 is campaign-scoped, so switching campaigns means a fresh harvest.

---

## Track A — Claude Code

Restart Claude Code so it picks up the `.mcp.json` from step 4. After restart, the `roll20-dm` and `roll20-dm-maps` tools will be available.

You can verify this is working by asking Claude: `list_campaigns` or `active_campaign`.

Use Claude Code for map prep, deploying tokens before a session, and running combat. It's complete on its own.

---

## Optional — the Gem

The Gem is an Electron overlay that floats on your screen. It shows a glowing faceted gem that you hold PTT (push-to-talk) to talk to. An expanded "Scrying Ledger" panel gives you chat, player inbox, and configuration tabs.

> **The Gem lives in its own repository now.** It was split out to
> [`eschatus/dm-whisper`](https://github.com/eschatus/dm-whisper) on 2026-08-11 and is closed
> source; this repository is the MCP server it talks to, and stays open under MIT. Everything in
> this section happens in that checkout, not this one — including its own setup instructions, which are
> canonical. You don't need it to use this server.

What matters from *this* side of the relationship:

- The Gem pins this repository as a dependency by tag (currently `#v2.5.0`) and builds it in the clone, so you do not need a separate checkout of roll20-dm-mcp for the Gem to run. Changes here reach the Gem only when it re-pins.
- It bundles `skills/dm-rules.md` and `mod-scripts/ai-relay.js` from this repo into its installer.
- It harvests the two credential files from step 5 itself.
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
4. If you run the Gem, say or type: `"who's on the map?"` — should list tokens.

If `list_tokens` fails, work down this list:

- **"No usable Roll20 realtime token…"** — this campaign has no stored token from step 5, or Firebase refused it; the message says which, and a token for another campaign is never used. Run `npm run furnish:token` with *this* campaign open (Gem users: reconnect Roll20 in the Gem). Check `transport_status.rtToken` first: `present` and `ageMinutes` describe the active campaign's token, and `campaignMismatch: true` means `ROLL20_RT_TOKEN` is set for a different game.
- **Timeout / "sandbox unreachable"** — the Mod script isn't running. **Someone must be in the game:** Roll20 parks the sandbox soon after the last player leaves. If someone is, check the campaign's API Output Console for the load banner (step 3) and re-paste if it's absent or the version is stale.
- **Relay version mismatch in `transport_status`** — re-paste `mod-scripts/ai-relay.js` into that campaign.
- **Map tools missing or failing to load** — run `npm run build`; `roll20-dm-maps` runs the compiled `dist/`.
