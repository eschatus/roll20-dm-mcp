# Skill: DM Combat Narration

Listen for natural-language combat narration and sync HP/conditions to both Roll20 and D&D Beyond simultaneously.

## When to use

Invoke this skill at the start of a combat encounter, or whenever the DM wants natural-language combat updates to be automatically synced to both platforms.

## Input format

The DM speaks naturally. Examples:
- "Eli takes 9 piercing damage and is poisoned"
- "The party heals — Zara casts cure wounds on Torinn for 11"
- "Draven drops to 0 HP — he's unconscious"
- "The poison wears off of Eli"
- "Everyone takes 6 fire damage from the dragon's breath"

## Steps

1. **Extract intent from narration**
   - Characters affected (use fuzzy name matching against registry)
   - Damage or healing amount
   - Conditions to apply or remove
   - If multiple characters are affected, handle each in sequence

2. **Confirm if ambiguous**
   - If a character name doesn't match anyone in the registry, ask before proceeding
   - If damage amount is unclear, ask
   - Do NOT ask if the intent is clear — act immediately

3. **Apply the change**
   - For damage + conditions: call `apply_damage({ characterName, damage, conditions })`
   - For healing: call `heal_character({ characterName, amount })`
   - For condition-only changes: call `apply_condition` or `remove_condition`
   - For 0 HP / unconscious: call `apply_damage` with damage that would bring HP to ≤0, then `apply_condition({ characterName, condition: "unconscious" })`

4. **Report back**
   - State the new HP for each character updated
   - Confirm which conditions were applied/removed
   - Flag any platform update failures (e.g., "Roll20 updated but DDB returned an error")

## Example

> "The naga hits Eli, 9 piercing damage and he's poisoned"

Claude extracts: character="Eli", damage=9, conditions=["poisoned"]

Calls: `apply_damage({ characterName: "Eli", damage: 9, conditions: ["poisoned"] })`

Reports: "Eli takes 9 damage → 28/45 HP, poisoned. Roll20 token and D&D Beyond sheet updated."

---

> "Zara heals Torinn for 11"

Claude extracts: character="Torinn", amount=11

Calls: `heal_character({ characterName: "Torinn", amount: 11 })`

Reports: "Torinn healed 11 HP → 34/52 HP. Roll20 token and D&D Beyond sheet updated."

---

> "The dragon breathes fire — everyone rolls a dex save. Eli fails (23 fire), Torinn succeeds (11 fire), Zara fails (23 fire)"

Claude makes three sequential calls:
1. `apply_damage({ characterName: "Eli", damage: 23 })`
2. `apply_damage({ characterName: "Torinn", damage: 11 })`
3. `apply_damage({ characterName: "Zara", damage: 23 })`

Reports a summary table for all three.

## Tips for the DM

- Say character names clearly — the registry uses fuzzy matching so "Eli" matches "Elias Blackwood"
- If a character isn't registered yet, use `create_pc_token` first to link their Roll20 token and DDB sheet
- Use `sync_character_state` after a long rest or if you suspect HP drift between platforms
