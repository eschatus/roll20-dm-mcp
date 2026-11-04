# Roll20 MCP Server — Setup Guide for DMs

*Give your local Claude live access to your own Roll20 game.*

This sets up a small local server on **your own machine** that lets Claude read and write **your own** live
Roll20 game. Everything runs locally — you log in as yourself, and nothing is shared with anyone else. Point it
at whatever campaign you run. Plan on about **20–30 minutes**, most of which is downloads.

> **Works on macOS and Windows.** The commands are the same on both; where a step differs, you'll see a **macOS**
> line and a **Windows** line. (Linux works too — follow the macOS path.)

> This is the friendly, group-oriented walkthrough. For the fuller technical reference (env vars, the two servers),
> see [`setup-guide.md`](setup-guide.md).

**Roll20 only.** This server does not touch D&D Beyond. DDB character and monster lookups moved to a separate
server, [beyond-mcp](https://github.com/eschatus/beyond-mcp). Nothing you do
here needs a D&D Beyond login.

---

## Before you start — read this first

- **You need Roll20 Pro or Mentor.** The server works by running a small script inside your campaign's
  **Mod (API) Scripts** console, and that feature is subscriber-only. Without it, nothing here will work.
- **Log in with the GM account for your campaign.** The server's write commands (HP, tokens, turn order, etc.)
  are **GM-only** — the in-game helper ignores commands from anyone who isn't a GM. As the DM you already are one,
  so just make sure the Roll20 account you use is the same account that GMs the game.
- **Node.js 20 or newer** must be installed. Check with `node --version`. If you don't have it, get it from
  [nodejs.org](https://nodejs.org) (LTS) or via a package manager (Step 1).
- **This server never logs you into Roll20 for you.** There is no browser in it at all. It reads a Roll20 token
  out of a file, and Step 7 puts it there with two pastes.
- **Folder gotcha:** keep the project out of synced/protected folders — on macOS that's
  Documents/Desktop/Downloads/iCloud, on Windows that's OneDrive-synced folders. Your home folder is safe
  (details in Step 2).

---

## Installation

### Step 1 — Open a terminal & confirm Node is ready

- **macOS:** open **Terminal** (Applications → Utilities, or Spotlight-search "Terminal").
- **Windows:** open **PowerShell** (Start menu → search "PowerShell").

Then run:

```bash
node --version
```

You want `v20.x` or higher. If it errors or shows an older version, install Node first:

**macOS**
```bash
brew install node        # or download the LTS installer from nodejs.org
```

**Windows**
```powershell
winget install OpenJS.NodeJS.LTS   # or download the LTS installer from nodejs.org
```

You'll also need **git**. macOS usually has it; on Windows, install "Git for Windows" from
[git-scm.com](https://git-scm.com) if `git --version` fails.

### Step 2 — Clone the repository (into your home folder)

A fresh terminal window starts in your home folder, which is exactly where you want this. Run:

```bash
git clone https://github.com/eschatus/roll20-dm-mcp.git
cd roll20-dm-mcp
```

That lands the project at `~/roll20-dm-mcp` (macOS) or `C:\Users\you\roll20-dm-mcp` (Windows).

> ⚠️ **Keep it out of synced/protected folders.**
> **macOS:** don't put it in Documents, Desktop, Downloads, or iCloud Drive — privacy protection (TCC) blocks
> background access there and causes confusing "Operation not permitted" errors if you ever auto-start the server.
> **Windows:** avoid OneDrive-synced folders (often Documents/Desktop) — live file-syncing can lock or duplicate
> the config files. Your home folder, as above, is safe on both.

### Step 3 — Install dependencies

```bash
npm install
npm run build
```

`npm install` pulls the packages. **There is no browser to install** — this project has no Playwright and never
opens a browser window of its own.

`npm run build` compiles the code. You only strictly need it for the **map-prep server** (Step 6), but running it
now saves a step later.

> **There is no `voice-hud/` folder any more** — the voice-control app ("the gem") moved to
> [its own repository](https://github.com/eschatus/dm-whisper) on 2026-08-11. This checkout is the MCP server.

### Step 4 — Put the helper script into your Roll20 campaign

This is the piece that actually touches your game. The server sends it instructions; it does the work inside
Roll20. **Nothing works until this is done**, and it has to be done **once per campaign** — each Roll20 game
carries its own copy.

1. Open your Roll20 campaign as GM.
2. Go to **Settings → API Scripts** (Mod Scripts).
3. Click **New Script**.
4. Open `mod-scripts/ai-relay.js` from the folder you cloned in Step 2, select **all** of it, and paste it in.
5. Click **Save Script**.

**Check that it loaded — don't just trust the save.** Roll20 will happily save a script that then fails to start.
Look at the **API Output Console** on that same page; you want to see:

```
[GM_AI_Bridge] Relay script loaded (v2.7.0)
```

If you see a red error instead, the paste was incomplete — clear the box and paste again.

> Copy the script again (and re-check that banner) whenever you update this project — the version in Roll20 does
> not update itself. Different campaigns can end up on different versions; that's normal, but the banner tells you
> which one you're looking at.

> **Note:** The script only obeys GMs. Players typing in chat cannot trigger it.

### Step 5 — The `.mcp.json` config file

This file is how Claude finds the server. **You don't have to create it** — the first `npm run serve` in Step 6
creates it for you, in the `roll20-dm-mcp` folder, named exactly `.mcp.json` (it's gitignored, since it ends up
carrying your access token, so a fresh clone has none until that first run makes one). This is what it looks
like afterward:

```json
{
  "mcpServers": {
    "roll20-dm": {
      "type": "http",
      "url": "http://127.0.0.1:39200/mcp",
      "headers": { "Authorization": "Bearer <your generated token>" }
    },
    "roll20-dm-maps": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/roll20-dm-mcp/dist/index-maps.js"],
      "cwd": "/ABSOLUTE/PATH/TO/roll20-dm-mcp"
    }
  }
}
```

The two entries are the two servers:

- **`roll20-dm`** — live combat: HP, conditions, initiative, dice, narration, zones. Runs over HTTP on port
  39200, and only works while Step 6's terminal is running.
- **`roll20-dm-maps`** — map prep: uploading battlemaps, drawing dynamic-lighting walls and doors, placing
  tokens. Claude starts it on demand, so there's no terminal to keep open — but it runs the compiled code, so
  re-run `npm run build` after any update.

If you'd rather hand-edit this file first (a different port, dropping `roll20-dm-maps` if you only ever run
live combat, adding other MCP servers), go ahead — Step 6 only fills in whichever of the two entries above are
missing and refreshes the `roll20-dm` bearer header; it won't stomp on anything else you add.

### Step 6 — First run

```bash
npm run serve
```

On first launch this generates a private access token, saves it to a local `.env` file, and **creates or updates
`.mcp.json`** (Step 5) with that token in the `roll20-dm` block's `Authorization` header. **Leave this running**
in its terminal window — it's the server. To stop it later, press `Ctrl+C` (same on macOS and Windows); to start
it again, just `npm run serve` from the same folder.

> **Note:** The access token is unique to your machine. Nobody shares these — that's why each person does their
> own install instead of copying files around.

### Step 7 — Give the server a Roll20 access token

The server talks to Roll20 over Roll20's own realtime connection, and to do that it needs a token file at
`data/roll20-rt-token.json` inside the project folder. **The server never fetches this itself.** If the file is
missing, stale, or belongs to a different campaign, every Roll20 command fails with a message telling you exactly
which of those it is.

With only your campaign's Roll20 **editor** open in Chrome or Edge (the play screen, not the details page; you must
be a **GM** of the campaign), run this in the project folder:

```powershell
npm run furnish:token
```

1. It prints a long line and copies it to your clipboard where it can. Press **F12** in the editor, click
   **Console**, paste the line and press Enter. If Chrome warns about pasting, type `allow pasting` first.
2. A popup appears with the text selected. Press **Ctrl+C**, then **Enter**.
3. Paste into the waiting terminal and press Enter. Nothing shows as you paste; that's normal.

It checks you're the GM and that the database address is right, then writes `data/roll20-rt-token.json`. If
something's wrong it says what, in one line.

**This is a long-lived login.** It keeps working through server restarts, and also after you sign out of Roll20,
and there's currently no way for you to cancel it. Never paste the popup's text into a chat. Keep the `data`
folder private.

> **Uploading your own battlemap art** needs a second file, which lasts 8 hours. With the editor open, press **F12**,
> open **Network**, reload, right-click the top request (named like `editor/`) → **Copy** → **Copy as cURL**, then run
> `Get-Clipboard | npm run furnish:token -- --upload` (macOS: `pbpaste | npm run furnish:token -- --upload`). Without
> it, art upload fails with a clear message and everything else keeps working.

> Running the DM Whisper gem? It does all of this with its **Connect Roll20** button. Point it and this server at the
> same data folder; see [`setup-guide.md`](setup-guide.md).

### Step 8 — Connect Claude to the server

**Claude Code desktop app (most of us):** Open the `roll20-dm-mcp` folder **as your project/working folder**, then
fully quit and reopen the app. It reads `.mcp.json` on startup.

**Claude Code command-line (CLI):** Running `claude` from inside the `roll20-dm-mcp` folder picks up the project
`.mcp.json` automatically.

> ⚠️ `.mcp.json` only takes effect when the `roll20-dm-mcp` folder is the one Claude has open, and it's read at
> **startup** — so restart Claude after Step 6. This is the single most common thing that trips people up: the file
> exists, but Claude was started before it, or in a different folder.

### Step 9 — Register your campaign and make it active

The server needs to know which game to drive. Find your **Roll20 campaign ID** in the browser address bar — click
**Settings → Game Details** (or open the game's details page); it's the number right after `/details/`:

```
app.roll20.net/campaigns/details/1234567/your-game-name
                                  ^^^^^^^ this number
```

Then give Claude that ID and a name of your choosing. Easiest is plain English — e.g. *"register my campaign
'Curse of Strahd', Roll20 ID 1234567, and switch to it."* — or if you prefer the exact tool calls:

```
register_campaign name="Your Campaign Name" \
  roll20CampaignId="1234567" ddbCampaignId="0"
switch_campaign slugOrName="your-campaign-name"
```

> **What's `ddbCampaignId`?** Just a label. This server does no D&D Beyond lookups of any kind — it only stores
> the number and hands it to the separate beyond-mcp server if you use one. If you have a D&D Beyond campaign,
> put its ID here (the number at the end of `dndbeyond.com/campaigns/987654`); if you don't, `0` is fine.

You only register a campaign once. To run several games, register each and use `switch_campaign` to change which
one is live. **Remember that the Roll20 token from Step 7 is per-campaign** — switching games means repeating Step 7 in the
new one.

### Step 10 — Verify it works

Ask Claude to run `list_campaigns` — you should see your campaign marked active. Then drop a token on the map
and ask Claude to "list the tokens on the current page." If that returns real data, you're fully connected.

If they error, `transport_status` is the one-stop diagnostic: it reports whether the server can reach Roll20 and
whether the helper script version in your campaign matches what this server expects.

---

## Optional — a double-click launcher (skip the terminal)

Once you've installed everything, starting the server on later days is just `npm run serve` from the project
folder. If you'd rather not open a terminal each time, make a desktop icon that does it for you. **Do the full
install first** — this only *starts* the already-installed server. (It does not refresh your Roll20 token; that's
still Step 7.)

### macOS — a `.command` file

Paste this whole block into **Terminal** once. It creates the launcher on your Desktop and makes it
double-clickable in one go:

```bash
cat > ~/Desktop/"Start Roll20 Server.command" <<'EOF'
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd ~/roll20-dm-mcp
npm run serve
EOF
chmod +x ~/Desktop/"Start Roll20 Server.command"
```

Now double-click **Start Roll20 Server** on your Desktop to launch it. (The `PATH` line makes sure it finds Node
whether you installed via Homebrew or the official installer.)

### Windows — a `.bat` file

1. In File Explorer, turn on **View → Show → File name extensions** (so you can rename the extension).
2. Right-click an empty spot on the Desktop → **New → Text Document**.
3. Open it and paste the three lines below, then Save.
4. Rename the file from `.txt` to `Start Roll20 Server.bat` (confirm the "change extension?" prompt).

```bat
@echo off
cd /d "%USERPROFILE%\roll20-dm-mcp"
npm run serve
```

Double-click the `.bat` file to launch. You can right-click it → **Send to → Desktop** to make a nicer shortcut,
or pin it to the taskbar.

> **First launch may show a safety prompt.** macOS: if Gatekeeper says "unidentified developer," right-click the
> file → **Open** → **Open** (once only). Windows: if SmartScreen warns, click **More info** → **Run anyway**
> (once only).
>
> The launcher opens a window that stays up while the server runs — that's normal, it's showing the log. Closing
> that window (or pressing `Ctrl+C` in it) stops the server.

---

## Troubleshooting

**Claude doesn't see any roll20 tools.**
The `.mcp.json` wasn't picked up. Make sure the server ran at least once (Step 6 — that's what creates the file,
Step 5), that the server is running now, that the `roll20-dm-mcp` folder is the open project folder, and that
you **restarted Claude after** the file was written. This restart-after step is the single most common thing
people miss.

**"No usable Roll20 realtime token…"**
The token file from Step 7 is missing, was refused, or belongs to a different campaign — the message tells you
which. Redo Step 7 with *this* campaign open, then restart the server.

**Everything works except uploading map art.**
That's the second credential — `data/roll20-upload-cache.json`, which expires after 8 hours. Redo the upload step
at the end of Step 7. Combat is unaffected.

**The gem says it connected, but the server still can't find a token.**
The two are writing to and reading from different folders. See the `ROLL20_DATA_DIR` / `DMW_DATA_DIR` warning in
Step 7.

**`which claude` (macOS) or `where claude` (Windows) comes back empty.**
The command shell Claude runs in is sandboxed and doesn't have your normal PATH — that's expected and harmless.
Check your real terminal instead, or just use the desktop app's settings UI.

**My writes silently do nothing (HP changes, token edits, etc.).**
The Roll20 account behind the token isn't a GM on that campaign. The in-game helper only accepts commands from
GMs. Use your GM account (or have yourself added as a GM), then reconnect.

**Server won't start / "Operation not permitted" or file-lock errors.**
The project is in a synced or protected folder. **macOS:** move it out of Documents/Desktop/Downloads/iCloud to
`~/roll20-dm-mcp` (Step 2). **Windows:** move it out of any OneDrive-synced folder into
`C:\Users\you\roll20-dm-mcp`. Re-clone there if it's easier than moving.

**A Roll20 command timed out / "sandbox unreachable."**
**Someone has to be in the game.** Roll20 parks the helper script soon after the last player leaves, so open your
game first. If you're already in it, the helper script may have stopped. Open your campaign's **Settings → API Scripts**, check the output
console for errors, and re-paste `mod-scripts/ai-relay.js` if the load banner isn't there (Step 4). `transport_status`
will also tell you if the deployed version is older than the one this server expects.

**Map tools are missing, or fail with a "cannot find module" error.**
The map server runs compiled code. Run `npm run build`, then restart Claude.

---

## Good to know

- **Reads are always safe.** Looking things up (character HP, journal, tokens) never conflicts with anything, so
  query freely.
- **Sharing a game with a co-DM? Don't both run live combat at once.** If two people point their servers at the
  same Roll20 game, they don't coordinate — simultaneous writes (HP, turn order) can stomp each other. Fine one
  person at a time; risky in parallel. (Not a concern if you're the only one driving your game.)
- **Run several games?** Register each with `register_campaign` and hop between them with `switch_campaign` — no
  reinstall needed. Just remember the Roll20 token is per-campaign.
- **Roll20 has to be running the helper script, per campaign.** A new campaign means a new paste (Step 4).
- **Stop your server when you're done** (`Ctrl+C`) if you'd rather it not hold a live Roll20 connection open.
  Restart anytime with `npm run serve`.
- **The combat server needs no AI API key.** An `ANTHROPIC_API_KEY` is only used by the map-prep server's
  battlemap-analysis tool.

---

*Runs locally on your machine — your Roll20 credentials and access token never leave it.*
