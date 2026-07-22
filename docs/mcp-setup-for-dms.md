# Roll20 & D&D Beyond MCP Server — Setup Guide for DMs

*Give your local Claude live access to your own Roll20 game.*

This sets up a small local server on **your own machine** that lets Claude read and write **your own** live
Roll20 game and read your D&D Beyond characters & monsters. Everything runs locally — you log in as yourself,
and nothing is shared with anyone else. Point it at whatever campaign you run. Plan on about **15–20 minutes**,
most of which is downloads.

> **Works on macOS and Windows.** The commands are the same on both; where a step differs, you'll see a **macOS**
> line and a **Windows** line. (Linux works too — follow the macOS path.)

> This is the friendly, group-oriented walkthrough. For the fuller technical reference (the Gem overlay, API keys,
> Mod deployment, env vars), see [`setup-guide.md`](setup-guide.md).

---

## Before you start — read this first

- **Log in with the GM account for your campaign.** The server's write commands (HP, tokens, turn order, etc.)
  are **GM-only** — the in-game helper ignores commands from anyone who isn't a GM. As the DM you already are one,
  so just make sure the Roll20 account you log in with (Step 6) is the same account that GMs the game. Reads work
  from any account.
- **Node.js 20 or newer** must be installed. Check with `node --version`. If you don't have it, get it from
  [nodejs.org](https://nodejs.org) (LTS) or via a package manager (Step 1).
- **You'll log in through a browser window once.** The first time Claude touches Roll20 or D&D Beyond, a Chrome
  window pops up and waits for you to log in normally. That login is remembered afterward.
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

This pulls the packages and a dedicated Chromium browser the server uses. **Ignore the `voice-hud/` folder
entirely** — that's a separate voice-control app ("the gem") you don't need.

```bash
npm install
npx playwright install chromium
```

### Step 4 — First run (this configures everything)

```bash
npm run serve
```

On first launch this automatically generates a private access token, saves it to a local `.env` file, and writes
a `.mcp.json` config file into the project folder. **Leave this running** in its terminal window — it's the server.
To stop it later, press `Ctrl+C` (same on macOS and Windows); to start it again, just `npm run serve` from the
same folder.

> **Note:** The token and browser login are unique to your machine. Nobody shares these — that's why each person
> does their own install instead of copying files around.

### Step 5 — Connect Claude to the server

**Claude Code desktop app (most of us):** Open the `roll20-dm-mcp` folder **as your project/working folder**, then
fully quit and reopen the app. It reads the `.mcp.json` that Step 4 created on startup. If the app has an
MCP-server settings screen, you can instead add it there using the URL and token from `.mcp.json` (type: HTTP).

**Claude Code command-line (CLI):** Running `claude` from inside the `roll20-dm-mcp` folder picks up the project
`.mcp.json` automatically.

> ⚠️ The `.mcp.json` only takes effect when the `roll20-dm-mcp` folder is the one Claude has open, and it's read at
> **startup** — so restart Claude after Step 4. This is the single most common thing that trips people up: the file
> exists, but Claude was started before it, or in a different folder.

### Step 6 — Log in (one time)

Ask Claude to do something that touches Roll20 — the first time, a Chrome window opens for you to log into Roll20
(and, when needed, D&D Beyond). Log in with your **GM account**; it continues automatically and remembers you from
then on.

### Step 7 — Find your campaign's two IDs

The server needs to know which game to drive. Each campaign has two IDs, both of which live right in the browser
address bar.

**Roll20 campaign ID** — In Roll20, open your game and click **Settings → Game Details** (or use the game's
details page). The ID is the number in the address bar, right after `/details/`:

```
app.roll20.net/campaigns/details/1234567/your-game-name
                                  ^^^^^^^ this number
```

**D&D Beyond campaign ID** — On D&D Beyond, open your campaign page. The ID is the number at the end of the address:

```
dndbeyond.com/campaigns/987654
                        ^^^^^^ this number
```

> **Note:** No D&D Beyond campaign? You can still register with a made-up placeholder like `0` for the D&D Beyond
> ID — you just won't have the D&D Beyond character/monster read tools. The Roll20 side works fine on its own.

### Step 8 — Register your campaign and make it active

Give Claude both IDs and a name of your choosing. Easiest is plain English — e.g. *"register my campaign 'Curse of
Strahd', Roll20 ID 1234567, D&D Beyond ID 987654, and switch to it."* — or if you prefer the exact tool calls:

```
register_campaign name="Your Campaign Name" \
  roll20CampaignId="1234567" ddbCampaignId="987654"
switch_campaign slugOrName="your-campaign-name"
```

You only register a campaign once. To run several games, register each and use `switch_campaign` to change which
one is live.

### Step 9 — Verify it works

Ask Claude to run `list_campaigns` — you should see your campaign marked active. Then try a harmless read like
`active_campaign` or "list the tokens on the current page." If those return real data, you're fully connected.

---

## Optional — a double-click launcher (skip the terminal)

Once you've installed everything (Steps 1–4), starting the server on later days is just `npm run serve` from the
project folder. If you'd rather not open a terminal each time, make a desktop icon that does it for you. **Do the
full install first** — this only *starts* the already-installed server.

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
The `.mcp.json` wasn't picked up. Make sure the server (Step 4) is running, that the `roll20-dm-mcp` folder is the
open project folder, and that you **restarted Claude after** the file was created. This restart-after step is the
single most common thing people miss.

**`which claude` (macOS) or `where claude` (Windows) comes back empty.**
The command shell Claude runs in is sandboxed and doesn't have your normal PATH — that's expected and harmless.
Check your real terminal instead, or just use the desktop app's settings UI.

**My writes silently do nothing (HP changes, token edits, etc.).**
The Roll20 account you logged in with isn't a GM on that campaign. The in-game helper only accepts commands from
GMs. Log in with your GM account (or have yourself added as a GM), then try again. Reads work regardless.

**Server won't start / "Operation not permitted" or file-lock errors.**
The project is in a synced or protected folder. **macOS:** move it out of Documents/Desktop/Downloads/iCloud to
`~/roll20-dm-mcp` (Step 2). **Windows:** move it out of any OneDrive-synced folder into
`C:\Users\you\roll20-dm-mcp`. Re-clone there if it's easier than moving.

**A Roll20 command timed out / "sandbox unreachable."**
The in-Roll20 helper script may need a nudge. Ask Claude to check `transport_status`; if it's degraded, redeploy
the helper (the tooling has a one-command redeploy). Usually it resolves on its own within a minute.

---

## Good to know

- **Reads are always safe.** Looking things up (monster stats, character HP, journal, tokens) never conflicts with
  anything, so query freely.
- **Sharing a game with a co-DM? Don't both run live combat at once.** If two people point their servers at the
  same Roll20 game, they don't coordinate — simultaneous writes (HP, turn order) can stomp each other. Fine one
  person at a time; risky in parallel. (Not a concern if you're the only one driving your game.)
- **Run several games?** Register each with `register_campaign` and hop between them with `switch_campaign` — no
  reinstall needed.
- **Stop your server when you're done** (`Ctrl+C`) if you don't want it holding a browser session open in the
  background. Restart anytime with `npm run serve`.

---

*Runs locally on your machine — your logins and access token never leave it.*
