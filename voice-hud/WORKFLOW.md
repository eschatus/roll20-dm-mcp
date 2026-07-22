# Voice HUD — Combat Workflow Spec

How a combat session flows at the table, and what the agent does at each step. This is the spec for
the command detectors + choreography backbones in [`src/agent.ts`](src/agent.ts) and the prompt in
[`src/persona.ts`](src/persona.ts).

Operating rules (write-safety, real tool names, narration cadence, PC-initiative read-only) live in
the canonical [`../skills/dm-rules.md`](../skills/dm-rules.md). This file is the *procedure*; that
file is the *rules*. Where they overlap, dm-rules wins.

> **Phases are gone.** This file previously specified a five-state machine
> (`IDLE → SCENE_SET → INIT_PREP → COMBAT_LOOP → CLEANUP`) that also decided which tools the model
> could see. It was removed on 2026-07-19 — it locked the DM out of HP edits mid-fight, swallowed
> instructions, and wiped conversation history on every transition. See
> [`../docs/phase-removal.md`](../docs/phase-removal.md) for the harms and the before/after evidence.

---

## The shape of it now

**Capability is constant.** Every turn, the cloud model is handed the full `cloudToolAllowlist` (48
tools). What the DM can do never depends on what was said earlier, so there is no state to get stuck
in and no "wrong phase" to be rejected for. (Ollama still gets `cloud ∩ LOCAL_TOOLS` — a small model
genuinely does pick badly from 48 schemas. That pressure is real only there.)

**Three commands still have backbones**, because they encode ordering-critical steps worth
guaranteeing rather than trusting to the model:

| DM says | Backbone |
|---|---|
| "roll initiative" / "everyone roll" | NPC-only initiative, then queue tactics |
| "start combat" / "sort it" / "round one" | arm the turn hook, then read the settled order |
| "combat's over" / "the fight's done" | disarm hook · clear turn order · sweep zones · (then auras + PC sync) |

Everything else is just a turn: the DM speaks, the model picks tools.

**A backbone never consumes the turn.** It runs its tool steps and returns; `handle()` then always
routes the DM's transcript to the model. "Roll initiative, and the ogre takes 5" does both — under
the old machine the damage was silently dropped.

**Exit stays deliberate.** The close sequence is the one destructive choreography (clears turn
order, zones, syncs PCs), so it fires only on a high-precision phrase *and* every step is a gated
write. Two locks on the irreversible thing.

---

## Board review (no longer a macro)

The DM's opening narration used to trigger a `SCENE_SET` macro. That macro had no backbone — it set
a phase and printed a banner — and its trigger matched on word *form*, so "the goblin swings again"
mid-fight entered a scene while "the vampires close in" did not. Both are gone.

The procedure is still worth doing, and the model has every tool for it. Worked example:

> "...the party finds itself atop **Mount Baratok** in the **Curse of Strahd**, and are
> **surprised** when suddenly they're beset by several **vampires** and many children of the night
> **represented by wolves and swarms of bats**."

1. **Campaign** → "Curse of Strahd" → confirm / `switch_campaign curse-of-strahd` (don't thrash if
   already active).
2. **Map** → "atop Mount Baratok" → `get_current_page`, **verify** it's the Baratok map. The DM
   already placed the board, so this is a sanity check, **not** a navigation. If the current page
   isn't Baratok, flag it — never silently move off a board the DM set up.
3. **Cast** → `list_tokens`, match narrated types ("vampires / wolves / swarms of bats") to tokens
   present. Report GM-only: "Found 3 Vampire Spawn, 5 Wolf, 2 Swarm of Bats + 4 PCs." Flag any named
   type with no token.
4. **Rules keywords** → catch words like "surprised" and *surface them as a question* ("Party
   surprised — hold their round-1 turns?"). Don't silently apply mechanics that change player
   options.
5. Nothing pushed to the public channel.

("represented by wolves and swarms of bats" is agent-facing meta — never echoed to players.)

---

## INIT-PREP — stage the monster side (parallel with players)

Fires when the DM **calls for initiative**. Players do the laborious back-and-forth on their own
inits ("didn't have my token selected", "had advantage, reroll"); the agent burns that dead time:

- `roll_initiative npcOnly=true clearFirst=false` — NPCs join via the **only** safe path; never
  wipes player entries. Overlapping names auto-get epithets ("Wolf the Savage").
- **Nameplates on** — `set_token_props showname=true showplayers_name=true` across the NPCs in one
  `batch_exec`. **Everyone sees the names** (DM decision).
- **Tactics** — kick off `plan_all_tactics` so each monster's plan is queued before its turn.
- **Player initiative: untouched.** The agent only watches the entries settle.

## COMBAT — turn by turn

Begins when the DM says they're sorting / starting:

- `set_turn_hook enabled=true reset=true` · read the now-settled `get_turn_order` · surface the
  first turn + its queued tactical plan.
- **NPC turn** → act (with tactics) or as the DM directs.
- **PC turn** → wait. The player declares, the DM adjudicates rolls live. Then the DM PTTs the
  *results* — numerics + names/epithets ("the two Wolves take 14, Vampire Spawn the Savage drops").
  The agent applies: `update_hp_many` (batch) for HP, `set_token_marker` for conditions, and
  **rolls saves for named NPCs** via `roll_dice` when asked.
- **Output is a receipt, not a story.** State the mechanical change + at most one line of color. The
  DM owns narration. Player-facing: ASCII bar + Wounded marker, never exact HP. (See dm-rules.md.)
- **Round end** → terse mechanical summary (who's down, conditions, countdowns) + overwrite the
  combat-state snapshot. Never auto-advance the turn.

## CLEANUP — explicit close

Fires only on an explicit DM phrase. All gated writes:

`set_turn_hook enabled=false` · `clear_turn_order` · `list_zones` → `clear_zone` each ·
clear auras (`set_token_props aura1_radius=0`) · `sync_character_state` per PC.

The last two need a token list, so they ride along with the DM's own turn (appended as
`CLEANUP_SWEEP`) rather than replacing it. Closing combat also fires `onCombatEnd()`, which triggers
the After-Action Review and writes the `[agent] combat: end` log marker.

---

## Pinned follow-ups

- **Wider epithet field.** `MONSTER_EPITHETS` in
  [`../mod-scripts/ai-relay.js`](../mod-scripts/ai-relay.js) (~line 48) is keyed by monster type via
  substring match. The DM wants **more epithets, a broader adjective pool, and more mob types** —
  the current banks miss common CoS foes (vampire, wolf, dire wolf, swarm of bats). Add those types,
  lengthen the adjective arrays, and add a **generic fallback bank** for unmatched names.
- **`detectCombatOver` copula gap.** Matches "combat's over" but not "combat **is** over". Pinned in
  [`test/command-backbones.test.ts`](test/command-backbones.test.ts). Harmless now that nothing is
  gated on it; widening the pattern is a separate low-risk change.
