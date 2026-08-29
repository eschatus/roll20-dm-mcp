> 📖 **roll20-dm-mcp wiki** · [Home](Home) · [Setup](Setup) · [Voice HUD Gem](Voice-HUD-Gem)

# The Gem (DM Whisper)

The Gem is a floating overlay you run alongside Roll20 — a quiet assistant at your elbow. You run the table, you narrate, you make the calls; you hold a key, say the game fact, and the Gem does the bookkeeping while the story keeps moving.

![The scrying gem over a live Roll20 encounter](https://raw.githubusercontent.com/eschatus/roll20-dm-mcp/master/assets/gem-in-play.png)

## The Gem lives in its own repository

DM Whisper was split out of this project on 2026-08-11 and now lives at
**[github.com/eschatus/dm-whisper](https://github.com/eschatus/dm-whisper)** (closed source). That repository is
**canonical** for everything about the Gem itself: installing it, the voice/STT setup, PTT key bindings, the
Scrying Ledger panel and its tabs, the roster, nicknames and proper nouns, the inbox, gem appearance, and the
voice phrasings it understands.

This wiki covers the **server** the Gem drives — see **[Setup](Setup)**. What follows is only the seam between
the two, which is the part that lives on this side.

---

## What the Gem and this server owe each other

### The Gem furnishes the Roll20 credentials

This server reads Roll20 credentials out of files; it **never harvests them itself** and has no browser at all.
The Gem's **Connect Roll20** button opens a login window, you sign in as normal, and it writes:

| File | What it's for | How long it lasts |
|---|---|---|
| `roll20-rt-token.json` | Everything. **Campaign-scoped** — a token for one game cannot read another. | ~50 minutes from harvest |
| `roll20-upload-cache.json` | Uploading your own battlemap art | 8 hours |

Practical consequences:

- **Connect the Gem to the campaign you're about to run, before you press Connect.** Switching campaigns means
  reconnecting.
- **Reconnect at the start of a session.** The ~50-minute limit governs *making* a connection, not holding one —
  once the server is connected it stays live all evening — but a restart mid-session needs a fresh harvest.
- **The Gem and the server must share one data directory.** `DMW_DATA_DIR` (the Gem, `%APPDATA%\DM Whisper` on
  Windows by default) and `ROLL20_DATA_DIR` (the server, `./data` by default) have to resolve to the same folder.
  Otherwise the Gem harvests into a directory the server never reads — and the two also keep separate campaign
  registries, so they disagree about which campaign is active.

When a credential is missing, stale, or scoped to the wrong campaign, the server says so in plain terms rather
than failing vaguely. Reconnect in the Gem and try again.

### The Gem listens to the `/events` stream

The combat server publishes a bearer-authenticated SSE stream at `http://127.0.0.1:39200/events`. The Gem's HUD
is driven by it:

| Event | Carries |
|---|---|
| `combat-update` | turn order and the current round |
| `mob-plan` | a stored tactical plan for one token (or `null` when cleared) |
| `inbox-item` | a new `!dm` message from a player |
| `chat-message` | every live table chat message, including player `!`-commands |
| `map-ping` | a ping placed on the map, used to centre area effects |
| `sandbox-status` | whether the Roll20 Mod script is answering |

### The Gem does the thinking; this server does the Roll20 part

Two jobs moved out of the server and into the Gem:

- **Tactics.** The Gem decides what a group of monsters is going to do. The server only *stores* the result
  (`set_mob_plan`) and whispers it to the DM when that token's turn comes up. Plans persist until overwritten or
  cleared at the end of the encounter, so a stale plan resurfaces as a whisper — clear them when the fight ends.
- **Player `!`-commands.** Players' chat commands are answered by the Gem. The server forwards every table
  message as a `chat-message` event; it does not interpret them. The one exception is `!dm`, which the server
  itself queues into the DM inbox that the Gem's Inbox tab reads and replies through.

Stat lookups (monster stats, character AC and HP) come from a third server,
[beyond-mcp](https://github.com/eschatus/beyond-mcp), which the Gem also bundles. This server does not touch
D&D Beyond at all.

### The Gem pins this repository

The Gem installs roll20-dm-mcp as a dependency at a fixed tag — currently **`#v2.0.1`** — and builds it in its
own clone. So you do not need a separate checkout of this repo for the Gem to run, and changes made here reach
the Gem only when it re-pins. It also bundles this repo's `skills/dm-rules.md` and `mod-scripts/ai-relay.js`
into its installer.

---

## Two things that still bite

**The Mod script must be loaded, per campaign.** Roll20 only runs the helper script when your campaign is open,
and each campaign carries its own copy — so one game can be running an older version than another. After
updating, re-paste `mod-scripts/ai-relay.js` and confirm the console prints
`[GM_AI_Bridge] Relay script loaded (v2.5.0)`. Saving is not loading. See **[Setup](Setup)** step 3.

**Names must match the map.** The Gem matches what you say against the actual token names on the page — it won't
invent one. If you call the boss "the big guy", add a nickname in the Gem.
