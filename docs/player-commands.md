# Player Chat Commands

Players can type these in Roll20 chat. Replies arrive as whispers from
**GM-AI-Bridge** — nobody else sees them (except the public dice roll that
`!recall` makes).

## Command cheat sheet (share this with players)

| Command | What it does |
|---|---|
| `!tactics` | Reads the battlefield through your character's eyes and whispers what their instincts say. Sharper minds (Int/Wis) get sharper advice. |
| `!recall <creature>` | Rolls a knowledge check (Arcana/History/Nature/Religion, picked automatically) publicly, then whispers what your character actually knows. Roll well for real lore; roll badly for tavern rumors. |
| `!options` | Quick reminder of your action economy — action, bonus action, reaction, movement, remaining spell slots. Needs your D&D Beyond sheet linked. |
| `!recap` | Whispers a short bullet summary of recent table events (dice spam filtered out). |
| `!rules <question>` | Quick 5e rules lookup with a citation. If the assistant isn't confident, it passes the question to the DM instead of guessing. The DM's ruling always prevails. |
| `!help` | This list, whispered to you. |
| `!dm <note/question>` | (Pre-existing) Leave a note or question for the DM's assistant. |

## How it works

- **Detection** is transport-side: the RTDB chat subscription
  ([roll20-rt.ts](../src/bridge/roll20-rt.ts) `handleChatChild`) forwards live
  `!`-prefixed player messages to
  [player-commands.ts](../src/bridge/player-commands.ts). **No Mod redeploy was
  needed** — the Mod script is unchanged. Replies use the existing
  `whisperPlayer` relay action; `!recall` rolls via `rollFormulas` (real Roll20
  dice, public).
- **Requires the RT transport** (`ROLL20_TRANSPORT=rt`) and the HTTP server
  (`npm run serve`) running. Commands are not detected on the Playwright-only
  fallback path.
- **Security**: the GM-only `!ai-relay` boundary is untouched. Every handler is
  read-only plus whispers — players gain no campaign-mutation power.

## Information discipline

- Other creatures' stats never reach players as numbers. Wound states are
  qualitative words (`unhurt / lightly wounded / bloodied / badly wounded /
  near death`), distances are range bands.
- `!tactics` reuses the monster tactical AI's tier table
  ([tactics.ts](../src/tools/tactics.ts) `resolveTier`): a Wis 7 barbarian gets
  one blunt gut instinct from Haiku; an Int 18 wizard gets multi-step reasoning
  from Sonnet/Opus. Awareness radius scales with Wis (`awarenessRadius`).
  Only `objects`-layer tokens are visible — never the GM layer.
- `!recall` lore is banded by the check result vs. DC `10 + floor(CR/2)`:
  fail = folklore (possibly slightly wrong), pass = real traits qualitatively,
  pass by 5+ = tactical doctrine hints (Ammann index).
- `!rules` answers only when the model reports high confidence; otherwise the
  player is told it went to the DM, the GM gets a whisper, and a `[rules]`
  entry lands in the dmInbox.

## Cost & abuse guards

Per-player cooldowns: tactics 90s, recap 60s, rules 45s, recall/options 30s,
help 10s. Cooldown is recorded at dispatch, so a slow in-flight call can't be
stacked. `!tactics` thinking budgets are capped at 4000 tokens (interactive
latency) and responses at 400 tokens regardless of tier.
