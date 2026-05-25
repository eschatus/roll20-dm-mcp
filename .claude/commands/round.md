# Round Narration Parser

The DM is about to narrate what happened this round — either spoken to the players (voice-to-text) or typed directly. Parse it into a structured list of map actions and execute on confirmation.

## Step 0: Write the round state snapshot

At the end of every round (after narration posts), overwrite `C:\Users\escha\.claude\projects\e--personalProjects-roll20-dm-mcp\memory\session-combat-state.md` with the current combat state. This keeps context recoverable if compression happens mid-fight.

Format:
```
---
name: session-combat-state
description: Current combat state — overwritten every round
metadata:
  type: project
---
Round N — [Encounter name]

ACTIVE ENEMIES:
- Name: HP/maxHP (conditions)

PCs:
- Name: HP/maxHP (conditions, death saves if applicable) | Slots: L1:used/max L2:used/max … | Concentration: spell or none

DEAD THIS FIGHT: comma-separated names

Round N events: [2-3 sentence summary of what happened]
```

**Spell slot tracking**: DnD Beyond is not reliably writable from this workflow. Treat the snapshot as the authoritative state for spell slots and prepared spells. Update the snapshot whenever a PC casts a spell — this is our record, not DDB's. At round start, do a spot-check against DDB (call `ddb_get_character` for each PC) and note any discrepancies in the snapshot without trying to correct DDB.

## Step 1: Orient yourself

Before parsing the narration, quickly call `list_tokens` and `get_turn_order` if you don't already have the current combat state in context. You need to know: who's on the map, what layer they're on, and their current HP.

Also call `get_recent_chat limit=30` to see any Beyond20 dice rolls that came in this round — attack rolls, damage totals — you'll need these to fill in numbers the DM doesn't explicitly state.

**AoE templates are always pre-placed.** Whenever a player or the DM describes an AoE spell, assume a template token is already on the map (e.g. a cone, circle, or blast marker). Call `list_tokens` to find it (look for names like "60ft cone", "20ft radius", "AoE", or similar). Rename it to the spell (e.g. "Fireball", "Cloudkill") via `set_token_props`. Then use `find_tokens_in_range` centered on that token to get the intersection list — never guess targets by description alone.

## Step 2: Parse the narration

The DM's narration mixes player description with implicit mechanical info. Extract:

- **Damage events**: "the fireball catches the three goblins" → find goblin tokens, apply damage. Amount may be in the narration or in recent chat rolls. For AoE spells, check for a placed marker token first.
- **NPC saves**: Auto-roll using `roll_dice`. Use stat block bonuses — don't ask the DM. Check for resistances (Ghost = fire resist, etc.) and apply them silently.
- **PC saves**: Note as pending — the player rolls their own. Don't hold up the rest of the action list.
- **Undead Fortitude**: When a zombie/undead drops to 0 HP from non-radiant, non-crit damage, roll Undead Fortitude (DC = 5 + damage taken) automatically.
- **Conditions**: "the cultist is on fire" → `Burning`. "Heinz goes prone" → `Prone`. Use the campaign marker list.
- **HP directly stated**: "Zeno drops to 8 HP" → set HP to 8.
- **Deaths/unconscious**: "the goblin drops" → apply `Unconscious` / `dead` marker.
- **Wounded marker**: Apply `Wounded::4444333` when a token drops below 50% max HP. Remove when healed above half.
- **AoE template cleanup**: After resolving an AoE:
  - One-shot spells (Fireball, Cone of Cold, Thunder Wave): remove the template token via `removeObject`.
  - Persistent effects (Web, Cloudkill, Spike Growth, Wall of Fire): move the template to the map layer via `set_token_props layer="map"` so it lingers visually. Also rename it cleanly ("Cloudkill — Round N").
- **Zones to clear**: "the web burns away" → remove via `removeObject` or `clear_zone`.
- **Auras to set/clear**: concentration effects on tokens (use `set_token_props aura1_radius=…`).

**Voice-to-text is noisy.** "Brucepolis" = Beucephalus. "Bogor Zombie" = Ogre Zombie. "Arcmaige" = Archmage. Resolve by fuzzy-matching against the token list — don't ask unless genuinely unresolvable.

**Player names**: map to characters using the session's player→character table.

**When damage is ambiguous**: check recent chat for a matching roll. Take the first/higher result without asking.

## Step 3: Propose before executing

Output a numbered action list here in this chat. Be specific — include before/after HP:

```
1. Goblin the Savage: 8 damage (half, made save) → 7/15 HP
2. Goblin the Bold: 16 damage (full, failed) → dead
3. Cultist: 16 damage → 4/20 HP + Burning
4. Zeno: set HP to 8/45
5. Apply Prone to Heinz Craft
6. NPC saves needed: roll Goblin CON saves (DC 14) on confirm
```

Then say: **"Execute? (or say what to change)"**

## Step 4: Execute — dice first, then narration

On confirmation ("yes", "go", "do it"):

1. **Roll any needed NPC saves** via `roll_dice` — these appear in Roll20 chat for everyone to see.
2. **Apply all HP changes and conditions** using the results.
3. **Post a narration** to Roll20 chat via `send_narration` — dramatic description of what just happened, followed by a mechanic summary:

```
send_narration style=narration  → atmospheric description of the action
send_narration style=combat     → bulleted outcome list, no exact HP numbers
```

Combat summary format — ASCII bar and Wounded marker are the HP readout; never post exact numbers:
```
• Goblin the Bold → dead
• Cultist → ████░░░░░░ Burning
• Dante → ██░░░░░░░░ Wounded (2 failed death saves)
• Lara → unconscious
```

The narration + mechanic summary IS the table's confirmation prompt. Players see the dice, read the outcome, and correct anything wrong.

## Step 5: Top of round — recap + state check

At the top of each new round (when the turn order cycles back to the first combatant):

**1. Post a narrative recap** — use `style=dramatic`. Cover:
- Key events: who hit whom, who fell, what spells landed
- Turning points and deaths
- Current stakes: who's down, who's in danger
- No exact HP numbers in the recap. Wounded marker and bar are the player-facing readout.

**2. Spot-check DDB** — call `ddb_get_character` for each surviving PC. Compare spell slots against the snapshot. Note discrepancies in the session-combat-state.md without attempting to fix DDB. If a PC's DDB slot count is higher than our tracked count, note it as "DDB ahead of tracked — possible missed cast." If lower, note "DDB behind — possible external change."

**3. Check the turn hook.** If not firing, re-enable with `set_turn_hook enabled=true`.

Then ask: "Ready for next narration?"
