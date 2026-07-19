# Removing the DmPhase state machine

**Status:** done. **Date:** 2026-07-19.

The voice HUD used to run a five-state machine (`IDLE → SCENE_SET → INIT_PREP →
COMBAT_LOOP → CLEANUP`) that decided, among other things, **which tools the model
was allowed to see**. It is gone. Capability no longer depends on conversational
state.

## Why it was there

To shrink the tool schema. `config.ts` carried the reasoning: the full set is
~9.9k tokens, and small local models pick badly when handed 48 tools. Narrowing
per phase was meant to cut distractors and prevent wrong-moment calls.

That reasoning is sound **for local models** and was kept for them. It never
applied to cloud models, and the cost of pretending it did was severe.

## What it actually cost

Observed live on 2026-07-19 (session log `%APPDATA%/DM Whisper/hud.log`).

| # | Harm | Mechanism |
|---|---|---|
| **H1** | **Capability lockout.** HP / condition / AoE tools existed in **1 of 5** phases (`COMBAT_LOOP`). In `IDLE` the model was not merely discouraged from using them — they were absent from the payload. | `CONFIG.phaseTools` |
| **H2** | **Turn swallowing.** `initPrep` / `beginCombat` / `cleanup` took only `cb`, never the transcript, and `handle()` `return`ed after them. "Roll initiative, and the ogre takes 5" rolled initiative and **silently dropped the damage**. | `handle()` early `return` |
| **H3** | **History wipe.** `transitionPhase` set `started = false`, so the next turn re-ran `llm.start()`, which resets `history = []`. Crossing a boundary discarded the conversation mid-session. | `transitionPhase` |
| **H4** | **Internals leaked to the DM.** `PHASE_FOCUS.IDLE` instructed the model that "HP / conditions / initiative tools are NOT available", so it explained its own plumbing to the DM. | `PHASE_FOCUS` |
| **H5** | **The model asserted state it could not set.** Told "I put us back in combat", it replied "**COMBAT MODE ACTIVE**" — there was no tool to change phase, so nothing happened, and the next turn it reported "the phase has reverted to IDLE". | no phase tool |
| **H6** | **Entry keyed on word form, not meaning.** `detectSceneSet` matched bare nouns with `\b`, so "the goblin swings again" (mid-fight) entered a scene while "the vampires close in" (a real opening) did not. | `detectSceneSet` |

Compounding all of it: transitions were **strictly sequential and gated on the
current phase** (`detectBeginCombat(t) && this.phase === "INIT_PREP"`). There was
no utterance that moved `IDLE → COMBAT_LOOP`. A DM who missed a rung was locked
out of HP edits for the rest of the fight, with the model apologising about
phases instead of doing the work.

## What replaced it

- **Tools are never gated by state.** Cloud gets `cloudToolAllowlist` (48) on
  every turn. Ollama still intersects with `LOCAL_TOOLS` — the tool-count
  pressure is real only there.
- **Three explicit commands survive** — `detectCallForInit`, `detectBeginCombat`,
  `detectCombatOver` — because their backbones encode ordering-critical steps
  worth guaranteeing rather than trusting to the model: NPC-only initiative
  (`npcOnly: true, clearFirst: false`, so player entries survive), arming the
  turn hook before reading the order, and the gated close sequence.
- **Backbones are backbone-only.** They run tool steps and return; `handle()`
  then **always** routes the DM's transcript to the model. A command can no
  longer swallow the rest of the utterance (H2). The cleanup sweep that used to
  replace the DM's turn is appended to it instead (`CLEANUP_SWEEP`).
- **`sceneSet` and `detectSceneSet` are deleted.** The macro had no backbone at
  all — it set the phase and printed a banner — and its trigger was H6.
- **AAR re-anchored.** The After-Action Review used to hang off
  `onPhaseChange("CLEANUP")` and slice the log on `phase → COMBAT_LOOP`. It now
  uses an `onCombatEnd()` callback and the log markers `[agent] combat: begin` /
  `[agent] combat: end`, emitted by the begin/cleanup backbones.
- **Phase IPC deleted** (`send("phase")`, `get-phase`, preload hooks). It fed a
  UI badge that `renderer/gem.html` never consumed.

## Evidence

Before/after, same machine, same day.

**Automated suite** (`voice-hud`, vitest):

| | Before | After |
|---|---|---|
| Tests | 91 passed | **101 passed**, 8 skipped |

The runner itself was broken before this work — `vitest.config.ts` could not load
under vite 7 (`ERR_REQUIRE_ESM`), so **no** voice-hud test had been runnable.
Renaming it to `vitest.config.mts` fixed it; that was a prerequisite, since
without it there is no proof either side of the change.

**`eval-arc`** — stateful, board-verified, 7 scenarios × 3 reps against live
Haiku. This is the direct test of the gate's premise, because ungating grows the
schema the model must choose from (37 → 48 tools):

| Metric | Before (gated, 37) | After (ungated, 48) |
|---|---|---|
| Arc correct | 21/21 (100%) | **21/21 (100%)** |
| Mean latency | 2595 ms | **2544 ms** |
| Median | 2402 ms | **2317 ms** |
| p90 | 3551 ms | **3317 ms** |

Correctness held and latency did not regress. Note also that `eval-arc` only ever
ran in `COMBAT_LOOP` scope — the one phase where everything worked — which is
precisely why it never caught H1.

**Behavioural tests.** `test/phase-characterization.test.ts` pinned all six harms
as passing assertions against the old code, then became
`test/no-phase-regression.test.ts` with every assertion inverted. The diff
between those two files is the behavioural change, stated executably. If phases
(or any state-dependent gating of capability) return, that file fails.

## Known gap left alone

`detectCombatOver` matches "combat's over" / "fight's done" but **not** "combat
**is** over". Pre-existing and unchanged here; pinned in
`test/command-backbones.test.ts` so it isn't mistaken for a regression. It is now
harmless — nothing is gated on it, so the DM can simply say it again, or the
model can clear the order itself. Widening the pattern is a separate, low-risk
change.
