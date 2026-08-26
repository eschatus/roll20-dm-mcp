> 📖 **roll20-dm-mcp wiki** · [Home](Home) · [Setup](Setup) · [Voice HUD Gem](Voice-HUD-Gem)

# roll20-dm-mcp

AI-assisted D&D 5e session management for **Roll20**. The DM speaks; the gem acts.

![The scrying gem over a live Roll20 encounter](https://raw.githubusercontent.com/eschatus/roll20-dm-mcp/master/assets/gem-in-play.png)

Two local MCP servers that drive your own Roll20 game:

- **`roll20-dm`** — live combat over HTTP: HP, conditions, initiative, dice, narration, turn hooks, area
  effects, zones, the DM inbox.
- **`roll20-dm-maps`** — map prep over stdio: battlemap upload, wall and door detection, page setup, token
  placement.

Everything runs on your machine, against your own campaign, as your own GM account. You need a Roll20 **Pro or
Mentor** subscription, because the servers work through Roll20's Mod (API) Scripts.

## Guides (you don't need to clone the repo)

- **[Setup](Setup)** — install, configure, and first run.
- **[Voice HUD Gem](Voice-HUD-Gem)** — the push-to-talk scrying-gem overlay, and how it and the server fit together.

## Related projects

- **[dm-whisper](https://github.com/eschatus/dm-whisper)** — the Gem itself. Split out of this repo on
  2026-08-11 and canonical for anything about the overlay.
- **[beyond-mcp](https://github.com/eschatus/beyond-mcp)** — D&D Beyond character and monster lookups, which the
  Gem bundles. This repository does not touch D&D Beyond.

## Developer docs (in the repo)

The deep-dive material — architecture, the Roll20 realtime protocol, design decisions, security posture, API
coverage — lives **in the repository** under
[`docs/`](https://github.com/eschatus/roll20-dm-mcp/tree/master/docs), because it versions with the code and
would drift if copied here. Start with the repo
[README](https://github.com/eschatus/roll20-dm-mcp#readme) and `CLAUDE.md`.
