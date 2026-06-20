# Voice HUD — Combat Workflow Spec

The blueprint for the phase-aware Voice HUD agent. This describes **how a combat session flows at
the table** and **what the agent does in each phase**. It is the build spec for the phase
scaffolding + macros in [`src/agent.ts`](src/agent.ts) and the phase-scoped prompts in
[`src/persona.ts`](src/persona.ts).

Operating rules (write-safety, real tool names, narration cadence, PC-initiative read-only) live in
the canonical [`../skills/dm-rules.md`](../skills/dm-rules.md). This file is the *procedure*; that
file is the *rules*. Where they overlap, dm-rules wins.

---

## Why phases exist

The voice agent is a standalone loop ([`agent.ts`](src/agent.ts)), not Claude Code — it has no
skills or slash commands. Per utterance it builds one system prompt + one tool allowlist and runs a
tool loop. With a single flat prompt for every moment of play, two things break:

- **Wrong/no tool picked** — the model gets no signal whether combat is starting, mid-round, or
  ending; it infers everything from one utterance against a flat toolset.
- **Steps get dropped** — the multi-step setup/cleanup choreographies aren't encoded anywhere the
  agent reads.

The fix is **session phases**: each phase swaps in a focused prompt + a narrowed toolset (the
wrong-tool fix), and the entry/exit boundaries run **hybrid macros** — a code-driven backbone of
must-happen steps with judgment gaps left to the model (the dropped-steps fix).

## Trigger asymmetry (deliberate)

- **Entry is fuzzy.** The DM laces keywords into opening *narration*; the agent infers intent from
  prose. (See the worked example below — "represented by wolves and swarms of bats" is agent-facing
  meta, never echoed to players.)
- **Exit is explicit.** The DM says something deliberate to end the fight. The exit macro is the one
  destructive sequence (clears turn order, zones, syncs PCs), so it fires only on a high-precision
  phrase — and every step is a gated write on top of that. Two locks on the irreversible thing.

---

## State machine

```
IDLE
 │  opening narration, keywords laced in flavor        ──► fuzzy detect
 ▼
SCENE-SET     confirm campaign · verify page (don't navigate) · match + confirm cast ·
              flag rules keywords ("surprised") · SILENT to players · then stop
 │  DM calls for initiative
 ▼
INIT-PREP     (runs in parallel while players sort their own initiative)
              NPCs join the order · nameplates on · tactics started · player init untouched
 │  DM says "sort it / start"
 ▼
COMBAT LOOP   turn hook on · read settled order · surface first turn + its tactics
              per turn:  NPC → act + tactics   |   PC → wait, then ingest DM's PTT'd results
              round end: terse mechanical summary + state snapshot
 │  EXPLICIT phrase ("combat's over")                  ──► high-precision detect
 ▼
CLEANUP       turn hook off · clear turn order · clear zones · clear auras · sync PCs (gated)
 ▼
IDLE
```

`IDLE` (out of combat) scope is **combat-only + read-only lookups + journal/handouts**. HP /
condition / advance tools are not even in the IDLE allowlist, so the agent can't apply damage while
the DM is describing a scene.

---

## Phase detail

### SCENE-SET — resolve the board (read-mostly, silent to players)

Triggered by the DM's opening narration. Worked example:

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
5. **Stop.** No initiative, no turn order, nothing pushed to the public channel.

### INIT-PREP — stage the monster side (parallel with players)

Fires when the DM **calls for initiative**. Players do the laborious back-and-forth on their own
inits ("didn't have my token selected", "had advantage, reroll"); the agent burns that dead time:

- `roll_initiative npcOnly=true clearFirst=false` — NPCs join via the **only** safe path; never
  wipes player entries. Overlapping names auto-get epithets ("Wolf the Savage").
- **Nameplates on** — `set_token_props showname=true showplayers_name=true` across the NPCs in one
  `batch_exec`. **Everyone sees the names** (DM decision).
- **Tactics** — kick off `plan_all_tactics` so each monster's plan is queued before its turn. (This
  moves the tactics trigger *earlier* than the current combat-start hook.)
- **Player initiative: untouched.** The agent only watches the entries settle.

### COMBAT LOOP — turn by turn

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

### CLEANUP — explicit close

Fires only on an explicit DM phrase. All gated writes:

`set_turn_hook enabled=false` · `clear_turn_order` · `list_zones` → `clear_zone` each ·
clear auras (`set_token_props aura1_radius=0`) · `sync_character_state` per PC.

---

## Pinned follow-ups

- **Wider epithet field.** `MONSTER_EPITHETS` in
  [`../mod-scripts/ai-relay.js`](../mod-scripts/ai-relay.js) (~line 48) is keyed by monster type via
  substring match. The DM wants **more epithets, a broader adjective pool, and more mob types** —
  the current banks miss common CoS foes (vampire, wolf, dire wolf, swarm of bats). Add those types,
  lengthen the adjective arrays, and add a **generic fallback bank** for unmatched names.

---

## Build order (from this spec)

1. `Phase` state in `DmAgent` + thread it into `buildSystemPrompt(roster, provider, phase)` and
   `toolSpecs(provider, phase)`; phase allowlists in [`config.ts`](src/config.ts).
2. Detectors: fuzzy entry (scene-set / call-for-init / begin) + high-precision exit phrase.
3. Hybrid macros: `sceneSet()`, `initPrep()`, `beginCombat()`, `cleanup()` — code backbone, model
   fills judgment gaps.
4. Gem phase indicator in the HUD (makes fuzzy entry-detect visible/correctable).
5. (Pinned) widen `MONSTER_EPITHETS`.
