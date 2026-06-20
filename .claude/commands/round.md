# Round Narration Parser

The DM is about to narrate what happened this round — spoken (voice-to-text) or typed. Parse it
into a structured list of map actions and execute on confirmation.

**Operating rules:** follow `@skills/dm-rules.md` (write-safety, never auto-advance, conditions/
deaths/wounds, aura-vs-zone, narration cadence, voice-to-text resolution, real tool names). This
file covers the round-parsing choreography and the state snapshot.

## Step 0: Write the round state snapshot

At the end of every round (after narration posts), overwrite
`C:\Users\escha\.claude\projects\e--personalProjects-roll20-dm-mcp\memory\session-combat-state.md`
with the current combat state. Keeps context recoverable if compression happens mid-fight.

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

Round N events: [2-3 sentence summary]
```

**Spell slot tracking**: DDB is read-only **and exposes no spell-slot data via any MCP tool**
(`ddb_get_character` returns HP, temp HP, AC, passive perception, and conditions only — not slots).
So the snapshot is the **sole** authority for slots/prepared spells — there is nothing to spot-check
them against. Update the snapshot whenever a PC casts. You *can* spot-check HP/conditions against
`ddb_get_character`, but never slots.

## Step 1: Orient

If you don't already have current state in context, call `list_tokens` and `get_turn_order`
(who's on the map, what layer, current HP). Call `get_recent_chat limit=30` for this round's
Beyond20 rolls — attack/damage totals you'll need to fill in numbers the DM doesn't state.

**AoE templates are pre-placed.** When an AoE is described, assume a template token is already on
the map. `list_tokens` to find it (names like "60ft cone", "20ft radius", "AoE"), rename it to
the spell via `set_token_props`, then `find_tokens_in_range` centered on it for the target list —
never guess targets by description alone.

## Step 2: Parse the narration

Extract (see dm-rules.md for the condition/death/wound and voice-to-text rules):

- **Damage events** — find tokens, apply damage (amount from narration or recent chat rolls).
- **NPC saves** — auto-roll via `roll_dice` using stat-block bonuses; apply resistances silently.
- **PC saves** — note as pending; the player rolls their own. Don't hold up the action list.
- **HP directly stated** — set HP to that value.
- **Deaths/unconscious** — apply `Unconscious`/`dead`, then move dead tokens to the map layer.
- **AoE template cleanup** — one-shot spells: `remove_object` the template. Persistent effects
  (Web, Cloudkill, Spike Growth, Wall of Fire): move template to map layer + rename ("Cloudkill
  — Round N").
- **Zones/auras** — clear burned-away areas: `clear_zone` for a named zone made by `create_zone`;
  `remove_object` to delete a stray template graphic/token. Set/clear concentration auras on tokens
  via `set_token_props` (e.g. `aura1_radius=0` to clear; `layer="map"` to retire a template).

## Step 3: Propose before executing

Output a numbered action list with before/after HP:
```
1. Goblin the Savage: 8 damage (half, made save) → 7/15 HP
2. Goblin the Bold: 16 damage (full, failed) → dead
3. Cultist: 16 damage → 4/20 HP + Burning
4. Zeno: set HP to 8/45
5. Apply Prone to Heinz Craft
6. NPC saves needed: roll Goblin CON saves (DC 14) on confirm
```
Then: **"Execute? (or say what to change)"**

## Step 4: Execute — dice first, then narration

On confirmation ("yes/go/do it"):

1. **Roll needed NPC saves** via `roll_dice` (visible in Roll20 chat).
2. **Apply** all HP changes and conditions (use `batch_exec` for 2+ tokens).
3. **Post the receipt** via `send_narration` (`style=combat`): the outcome list only — no
   atmosphere prose, the DM narrates. Add at most one short line of color. Use the ASCII bar +
   Wounded marker — **never exact HP numbers**:
```
• Goblin the Bold → dead
• Cultist → ████░░░░░░ Burning
• Dante → ██░░░░░░░░ Wounded (2 failed death saves)
• Lara → unconscious
```
The narration + summary IS the table's confirmation prompt.

**Do not advance the turn** — wait for the DM to say so.

## Step 5: Top of round — recap + state check

When the order cycles back to the first combatant:

1. **Terse mechanical summary**: who fell, active conditions, effect countdowns, current stakes
   in a line or two. No exact HP numbers, no dramatic recap — the DM delivers the drama.
2. **Spot-check DDB** — `ddb_get_character` per surviving PC; compare **HP and conditions** to the
   snapshot and note discrepancies (without correcting DDB). DDB does not return spell slots, so
   slots can't be checked here — the snapshot is authoritative for those.
3. **Check the turn hook** — if not firing, re-enable `set_turn_hook enabled=true`.

Then: "Ready for next narration?"
