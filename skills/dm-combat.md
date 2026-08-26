# (Retired) DM Combat Narration

This file is **superseded** and intentionally left as a pointer. It described combat HP/condition
sync but referenced tools that no longer exist (`apply_condition` / `remove_condition`), so
following it would error.

Use instead:

- **`skills/dm-rules.md`** — the canonical DM operating rules (write-safety, conditions/deaths,
  real tool names, narration cadence).
- **`/combat`** (`.claude/commands/combat.md`) — combat-start choreography.
- **`/round`** (`.claude/commands/round.md`) — round narration parsing + execution.

For natural-language combat sync, the real tools are `update_token_hp` (HP for any token —
auto-routes NPC HP to the token bar, PC HP to relay state memory), `update_hp_many` (area
effects), and `set_token_marker` (single status marker). There is no `apply_condition`/
`remove_condition`, and no `full_sync_character`/`sync_character_state` — PC state is composed
from the primitives above plus `set_character_attribute` / `set_character_props` /
`read_character_attributes`. **There is no D&D Beyond in this server at all**, and DDB is
read-only wherever it lives — only players change their own DDB HP; there is no
`ddb_update_hp`/`apply_damage`/`heal_character` anywhere.
