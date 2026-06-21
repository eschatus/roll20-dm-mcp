> 📖 **roll20-dm-mcp wiki** · [Home](Home) · [Setup](Setup) · [Voice HUD Gem](Voice-HUD-Gem) · [Player Commands](Player-Commands)

# The Gem — DM Guide

The Gem is a floating overlay you run alongside Roll20. Think of it as a quiet assistant sitting at your elbow: you run the table, you narrate, you make the calls — the Gem handles the bookkeeping on your word.

The goal is to keep you in the story. You speak to your players, and with a key held down you speak to the Gem at the same time. Token HP updates, conditions, initiative — all happen in the background while the narrative keeps moving.

---

## The gem at a glance

![The scrying gem over a live Roll20 encounter](https://raw.githubusercontent.com/eschatus/roll20-dm-mcp/master/assets/gem-in-play.png)

The gem visual has four states:

| State | Appearance | Meaning |
|---|---|---|
| **Idle** | Dim, slow pulse | Standing by |
| **Listening** | Bright, fast pulse, ring active | PTT held — recording your voice |
| **Thinking** | Slightly dark, ring spinning | Processing your utterance |
| **Confirm** | Gold pulse | Waiting for your confirmation of a write |

A tactic strip appears across the bottom of the gem during combat, showing the current creature's tactic from the last tactical plan. Click it to expand the full plan.

The right boss (east medallion) lights up red when there are unread player messages in the Inbox.

---

## Before a session

### Build the roster

The Gem's roster is how it knows who's on the map and which tokens belong to which characters. Build it once after you've placed your tokens for the session.

Open the Scrying Ledger (click the ✦ button on the gem, or expand it), go to the **Roster** tab, and click **⟳ Rebuild roster**. You'll see a list of all tokens on the current page with their linked DDB characters (if any).

Rebuild after adding new tokens mid-session.

### Add proper nouns

Go to the **Proper Nouns** tab and add names, places, and spell names that Whisper tends to mishear. Campaign-specific names like "Strahd", "Barovia", "Ireena", or "Spirit Guardians" should all be here. Roster names are added automatically.

### Add nicknames

The **Nicknames** tab maps what you say to who you mean. If you often say "the big guy" when you mean Strahd, add that mapping. If you call your cleric "Z" but the token is named "Zeno", add that too.

---

## At the table — how it fits in

The key habit is: **hold PTT, speak the combat fact, release**. You do this while talking to your players, not instead of it.

The DM's voice serves two audiences simultaneously. When the naga strikes:

> (to the table) *"The naga coils and strikes — a vicious bite at Eli!"*  
> (hold Right Ctrl) *"Eli takes 12 piercing"* (release)

The players hear the narration. The Gem hears the game fact. The token updates in the background. Nobody looks at a spreadsheet.

A few habits that help:

- **Keep utterances short and factual.** "Eli takes 12" works. You don't need "please apply 12 piercing damage to Eli". The Gem is trained to extract the fact, not parse natural language prose.
- **Don't narrate twice.** The Gem can push narration to Roll20 chat if you ask ("tell the party the goblin snarls"), but you don't need to — your voice IS the narration. Let the Gem focus on state changes.
- **Use creature types for AoE.** "40 damage to every skeleton" hits all tokens with "skeleton" in the name. Much faster than listing names.
- **Write tools need a confirm.** The gem shows a gold glow when it's about to make a change. Tap Right Shift to confirm, Esc to cancel. Read-only operations (who's hurt, what's Eli's HP) run instantly.

---

## Voice cues that work well

These are natural-language phrases the Gem reliably understands:

**Damage and healing:**
- `"Eli takes 9"`
- `"Eli takes 9 piercing"`
- `"heal Zeno 12"`
- `"the party heals 8"` — heals all PCs
- `"set Strahd to 40 HP"` — for direct overrides

**Conditions:**
- `"mark Thorne prone"`
- `"Thorne is poisoned"`
- `"Leolen falls unconscious"`
- `"clear Eli's prone"`

**Area effects (see next section):**
- `"40 damage to every goblin"`
- `"fireball at the ping, 20 feet, 28 damage"`

**Initiative:**
- `"roll initiative"` — NPCs only; players set their own
- `"next turn"`

**Status checks:**
- `"who's hurt?"`
- `"what's Strahd's HP?"`
- `"who's in range of Strahd?"` (then give radius)

**Sending narration to players:**
- `"tell the party the door splinters inward"`
- `"narrate: a howl echoes from the forest"`

**Dice:**
- `"roll 2d6 fire damage"`
- `"Strahd attacks Eli, roll to hit"` — the Gem will roll and read the result

---

## AoE and area effects

The Gem has two modes for area effects: **name-match** (fast) and **ping-to-center** (precise).

### Name-match — fastest

When all targets share a creature type, just say it:

> *"Fireball — 28 damage to every skeleton"*

The Gem calls `update_hp_many` with `nameMatch="skeleton"` and hits all tokens whose name contains "skeleton" in one pass. No target list needed.

> *"The Web hits all the goblins for 0 — but mark them restrained"*

You can combine damage and conditions in the same breath.

### Ping-to-center — for precise placement

When you need to know exactly which tokens are in the blast radius (a spell that catches allies, a cone, a 15-foot burst in a tight corridor):

1. **Click and hold** on the center point on the Roll20 map. This sets a ping the Gem can read.
2. Tell the Gem: *"Fireball at the ping, 20-foot radius, 28 damage"*

The Gem draws a circle zone on the map, finds every token inside it, applies the damage, and leaves the zone visible so you can see the coverage. Clear it later with: *"clear the fireball zone"*.

The ping is remembered for 3 minutes, so you can place it a moment before you describe the spell going off.

### Persistent zones

For ongoing **fixed-area** effects — a Web, Cloudkill, Spike Growth, difficult terrain — the Gem can create a named zone that persists on the map:

> *"Create a Web zone centered on Thorne, 10 feet"*

The zone stays on the map. When a creature enters or leaves the area, you can ask: *"who's in the Web?"* and the Gem will check against the zone.

Clear a zone when the effect ends: *"clear the Web"*.

> **Emanations are different.** Spells that move *with* a creature — Spirit Guardians, Aura of Vitality, Paladin auras — are set as a **token aura**, not a zone (say *"give Thorne a 15-foot Spirit Guardians aura"*). A zone is a fixed patch of ground; an aura follows the token.

---

## Running combat

### Initiative

At the start of combat:

> *"Roll initiative for the goblins"*

Player initiative is **never touched** — players set their own in Roll20. The Gem only rolls for NPCs.

A round marker is injected into the turn order and auto-increments each round.

### During a turn

The Gem tracks the current turn and can remind you:

> *"What's the current turn?"*  
> *"Who's next?"*

When you're ready to advance:

> *"Next turn"*

The Gem never advances the turn automatically — that's your call.

### Tactical plans

When combat starts, the Gem generates a tactical plan for each NPC group (if the tactical assistant is enabled). The current creature's short-term goal appears in the tactic strip at the bottom of the gem. Click it to see the full plan with medium-term goal and overall objective.

![The expanded tactic tray — current creature's move/action plus other mobs](https://raw.githubusercontent.com/eschatus/roll20-dm-mcp/master/assets/gem-tactics-tray.png)

Plans update each round based on the current battlefield state.

### Ending combat

There's no explicit "end combat" command. Clear the turn order when you're done, or just move on — the round marker will stop advancing.

---

## The Scrying Ledger

Click **✦** on the gem (or press the scry button) to expand the full panel. Click **✕ close** to return to gem mode without quitting.

### Chat tab

The main conversation interface. Type anything here — questions, multi-step requests, anything that needs more than one short utterance. The Gem replies in themed text (your words in serif italic, agent replies in blackletter).

Switch between cloud (Anthropic) and local (Ollama) brain using the buttons at the top. Cloud handles complex multi-target operations better; local is faster and free but less accurate with complicated narration.

Toggle **show tool activity** to see the tool calls the Gem is making in real time — useful for debugging or learning what's happening under the hood.

### Inbox tab

Player messages sent via `!dm` in Roll20 chat appear here, classified by type (question, note, rules query). Rules questions that the assistant isn't confident about are also escalated here with the player's original text.

Click the reply field under any message to respond. Your reply is whispered back to the player in Roll20 chat.

The east medallion on the gem glows red with an unread count when new items arrive.

### Proper Nouns tab

Add names here to improve voice recognition accuracy. Anything the transcriber tends to mishear — especially proper nouns from your campaign — should live here. Changes take effect on the next PTT press.

![Proper Nouns tab — campaign names and terms that bias speech recognition](https://raw.githubusercontent.com/eschatus/roll20-dm-mcp/master/assets/ledger-proper-nouns.png)

### Nicknames tab

Map spoken shortcuts to actual token names. "The lich" → "Strahd von Zarovich". "Z" → "Zeno". The Gem resolves these silently so you never have to say the full name.

![Nicknames tab — "you say X → means Y" alias resolution](https://raw.githubusercontent.com/eschatus/roll20-dm-mcp/master/assets/ledger-nicknames.png)

### DM Notes tab

A free-form DM notebook for this campaign. Persists across sessions. Good for secrets, NPC voice notes, recurring plot reminders — anything you want to reference mid-session without leaving the gem.

### Roster tab

Shows the live token roster (current-page tokens matched to DDB characters). Rebuild it here after token changes.

Also contains **gem appearance** settings — color presets (Ruby, Emerald, Sapphire, Amethyst, Amber) and individual color pickers if you want a custom look. Changes apply live.

### Config tab

Network URLs, PTT key bindings, STT model settings, and LLM provider selection. Settings marked ★ require a restart of the Gem to take effect.

---

## Player commands

Players can type these in Roll20 chat and receive whispered replies:

| Command | What it does |
|---|---|
| `!tactics` | Your character's tactical read on the battlefield — intelligence-gated |
| `!recall <creature>` | Knowledge check on a creature — roll well for real lore, roll badly for rumors |
| `!options` | Your current action economy and remaining spell slots |
| `!recap` | A short bullet summary of recent table events |
| `!rules <question>` | 5e rules lookup; escalated to the DM if the assistant isn't confident |
| `!help` | This list, whispered to you |

See [player-commands.md](player-commands.md) for full details including cooldowns and information discipline.

---

## Tips and gotchas

**The Mod script must be open.** Roll20 unloads API scripts when the campaign isn't active. Make sure your campaign is open in the browser before starting a session.

**Rebuild the roster when you add tokens.** The roster is a snapshot — it doesn't update live. If you drop a new NPC mid-combat, rebuild before asking the Gem about them.

**Write tools confirm; read tools don't.** HP changes, conditions, turn advances, and narration all require a Right Shift confirm. If you speak and nothing happens, look for the gold glow and tap Right Shift.

**The Gem doesn't advance turns.** You're in control of pacing. "Next turn" is always an explicit command.

**Names must match the map.** If you say "the big goblin" and the token is named "Goblin Chief", add a nickname. The Gem matches against the actual token names — it won't invent a name.

**DDB lookups use a cached session cookie.** DDB stat reads (AC, spell save DC, monster stats) run browserlessly via a `CobaltSession` cookie harvested once on first login (exchanged for a short-lived token per request). If DDB calls start erroring, re-login to D&D Beyond in the background browser window to refresh the cookie. (Only if you've forced `DDB_TRANSPORT=browser` does it need a live Playwright DDB session.)
