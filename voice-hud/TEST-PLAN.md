# Voice HUD — Test Plan

Run this when you sit down with the gem. **Scope right now:** the narration rule change
(assistant reports mechanics + ≤1 line of color; the DM owns the story) plus the command
backbones in [`WORKFLOW.md`](WORKFLOW.md), which are built — walk section 3 at the gem to
verify the audio/overlay wiring.

Mark each case ☑ pass / ☒ fail and jot what it actually did.

---

## 0. Preconditions (must do — or you'll test stale code)

- [ ] **Build first.** `npm run build` in `voice-hud/` (tsc). `persona.ts` is compiled — the
  launcher runs `dist/`, it does **not** build. Without this, the narration change isn't live.
  - `dm-rules.md` is read at runtime, so it's already current — only the build matters.
- [ ] **Launch** via `voice-hud\launch-gem.vbs` (or `launch-gem.cmd`). It clears
  `ELECTRON_RUN_AS_NODE`, forces `DMW_PROVIDER=anthropic` (cloud Haiku), starts the MCP server on
  :39200 if needed, opens the gem.
- [ ] **Provider note.** The launcher forces **cloud**, so these cases exercise the *cloud* prompt
  (SPEED RULES + dm-rules.md). To also test the local 7B prompt, remove the `DMW_PROVIDER` line and
  relaunch, then re-run N1–N5.
- [ ] **Campaign/roster.** Be on a Roll20 page whose tokens match a DDB campaign roster — use
  **curse-of-strahd** (registered PCs). Avoid fabulous-faerun-firebirds (roster returns 0 names).
- [ ] **Have targets on the board:** a couple of NPCs (e.g. 2 Goblins / 2 Wolves) + at least one PC,
  turn tracker loaded, so damage / conditions / round-end are exercisable.
- [ ] **Keys:** PTT = **Right-Ctrl** (hold) or mouse side-button; **confirm a write = Right-Shift**;
  **cancel = Esc**.
- [ ] In the chat ledger, tick **"show tool activity"** so you can verify single-vs-looped tool
  calls.
- [ ] Keep the **Roll20 browser chat visible** — that's where player-facing `send_narration` lands;
  you'll check redaction there.

---

## 1. Narration rule — the change under test

> **Automated coverage.** These rules now have CI evals (run the real agent against
> scripted transcripts with a recording fake MCP — no gem, no Roll20):
> - **Structural** (`test/narration-live-eval.test.ts`, checkers in `test/structural.ts`):
>   N1 (HP call on the named target), N2 (one batched multi-target call, no loop),
>   N7 (no digits in player-facing narration), N8 (every claim backed by a real call).
> - **LLM-as-judge** (`test/narration-judge-eval.test.ts`, helper in `test/judge.ts`):
>   the subjective ones — N4 (doesn't balloon), N5 (refuses to over-narrate, k-of-3),
>   N6 (terse round-end). A calibration block grades the live judge on fixed good/bad
>   strings first. The judge *plumbing* + structural checkers are hermetic per-PR gates
>   (`judge.test.ts`, `structural.test.ts`); the live runs are opt-in
>   (`ROLL20_LLM_EVAL=1` + key) via the manual `llm-eval` workflow.
>
> The manual pass below stays useful for what the evals can't see: STT accuracy, the
> gem render, and PTT — and as a spot-check that the live table feels right.

For each: PTT, say the line, watch the **gem reply** (GM-facing), the **tool calls** (ledger), and
the **Roll20 public chat** (player-facing).

### N1 — Single-target damage = receipt, not prose
- Say: **"the goblin takes 7"**
- Expect: one HP call (`update_token_hp`/`update_hp_many`); gem reply a short receipt with exact HP
  ("Goblin: 7 → 4/15, bloodied"); **no paragraph, no story**. Any public post is a one-line receipt.
- [ ] Pass — states the mechanical change explicitly, ≤1 line of color.

### N2 — Multi-target = one batched call
- Say: **"fireball — 22 to both wolves and the goblin"**
- Expect: **one** `update_hp_many` (names[]/nameMatch), **not** a loop of single calls; receipt lists
  each result; no dramatic prose.
- [ ] Pass — single batched call + receipt.

### N3 — Conditions
- Say: **"mark the goblin prone and poisoned"**
- Expect: `set_token_marker` (or `batch_exec`); receipt names target + conditions; no freelance
  narration.
- [ ] Pass.

### N4 — Explicit narration carries *your* line (+ tiny color only)
- Say: **"tell the party the vampire hisses and melts into mist"**
- Expect: `send_narration` with text close to what you said, at most a few words of added color;
  **not** an invented paragraph; no exact HP; gem confirms briefly ("narrated").
- [ ] Pass — doesn't balloon into a scene.

### N5 — Refuses to over-narrate (the key behavioral check)
- Say: **"give the players a dramatic three-sentence recap of the round"**
- Expect (per the rule — *the DM owns the story, always*): it **stays terse / defers** — a brief
  factual summary at most, **not** a flowery dramatic recap, atmosphere prose, or NPC dialogue.
- [ ] Pass — held the line under an explicit ask. *(If you actually want it to comply on request,
  that's a rule we'd loosen — note it here.)*

### N6 — Round-end = terse mechanical summary
- After resolving a round, say: **"wrap up the round"** (or let the turn cycle).
- Expect: terse mechanical summary (who's down, conditions, effect countdowns) — **not** a dramatic
  recap. No exact HP to players.
- [ ] Pass.

### N7 — Player-facing HP redaction
- Across N1–N6, check the **Roll20 public chat**: **no exact HP numbers** ever reach players — only
  ASCII bar / Wounded marker / descriptive words ("bloodied", "near death").
- [ ] Pass — exact HP only on the GM gem, never public.

### N8 — No phantom effects
- Say: **"the ogre swings at Zeno for 12"**
- Expect: it actually **calls** the HP tool on Zeno and the receipt reflects the real tool result —
  it does **not** narrate "Zeno is hit!" without a write.
- [ ] Pass — every claimed effect has a tool call behind it.

---

## 2. Core-path regression (should already be green; confirms the build didn't break basics)

- [ ] **R1** — PTT captures; transcription in the ledger is readable.
- [ ] **R2** — A write tool raises the confirm banner; **Right-Shift** executes, **Esc** cancels —
  and cancel actually aborts the action.
- [ ] **R3** — A read ("**who's hurt?**") runs **without** a confirm gate and answers worst-first.
- [ ] **R4** — Roster resolved names (not 0); the DM's references map to the right tokens.
- [ ] **R5** — Gem reply shows exact HP (GM side) while the public channel stays redacted.

---

## 3. Command backbones + write gate (run to verify)

> **Phases are gone** (2026-07-19). The old five-state machine also decided which
> tools the model could see, which locked the DM out of HP edits mid-fight. See
> [`../docs/phase-removal.md`](../docs/phase-removal.md). Capability is now
> constant: the cloud model gets the full 48-tool allowlist every turn.
>
> **Most of this section is automated.** The command detectors, the choreography
> backbones (NPC-only initiative, turn-hook arming, gated cleanup) and the
> write-confirm gate are covered offline by
> [`test/command-backbones.test.ts`](test/command-backbones.test.ts); the guarantee
> that capability is never gated by state is covered by
> [`test/no-phase-regression.test.ts`](test/no-phase-regression.test.ts). Run both
> with `npm test` in `voice-hud/` (no gem, no Roll20, no model needed).
>
> The boxes below remain the **manual smoke pass** for what the suite cannot
> reach: mic capture, Whisper accuracy, the Electron overlay render, and the
> global PTT/confirm hotkeys.

**NOTE: These cases require the Electron gem to be running** — launch via
`voice-hud\launch-gem.vbs` (or `launch-gem.cmd`) and complete the section-0
preconditions first. The gem must be connected to a live Roll20 campaign with
tokens on the board.

### Setup
- Be in **curse-of-strahd** (or any registered campaign).
- Have at least 3 NPC tokens + 2 PC tokens on the current page, turn tracker empty.
- Tick "show tool activity" in the ledger so you can see which tools fire.

---

### C1 — Cold HP edit (the regression that motivated the removal)
- From a **freshly started gem**, with no initiative rolled and no combat declared,
  say: **"Set the Sahuagin High Priestess's hit points to fifty."**
- Expect: `update_token_hp` is called and the token's bar changes. No talk of
  phases, no "HP tools are locked", no ceremony required first.
- [ ] Pass — the write lands cold, with no preceding command.

### C2 — Init-prep: NPC initiative on "roll initiative"
- Say: **"Roll initiative."**
- Expect:
  - `roll_initiative` called with `npcOnly=true`, `clearFirst=false` (confirm banner appears).
  - After confirm: NPCs appear in the Roll20 turn order; player entries untouched.
  - `plan_all_tactics` called (confirm banner — tactics queue up).
- [ ] Pass — turn order shows NPCs only added; players did not lose their entries.
- [ ] `clearFirst=false` confirmed in the tool call args (check ledger).

### C3 — Begin combat: "sort it / start"
- Say: **"Sort it, let's start."**
- Expect:
  - `set_turn_hook` called with `enabled=true` (confirm banner).
  - `get_turn_order` called immediately after — settled order read back.
  - Gem surfaces first turn + its queued tactical plan.
- [ ] Pass — first combatant named; hook armed before the order read.

### C4 — A command does not swallow the rest of the utterance
- Say, in one breath: **"Roll initiative, and the ogre takes five."**
- Expect: the initiative backbone runs **and** `update_token_hp` is called for the
  ogre. Under the old machine the damage was silently dropped.
- [ ] Pass — both the backbone and the damage landed.

### C5 — Explicit exit: cleanup fires only on a deliberate phrase
- Say: **"The fight feels like it might be winding down."**
- Expect: NO cleanup triggered. Normal agent turn runs.
- [ ] Pass — "feels like winding down" does NOT trigger cleanup.

- Then say: **"Combat's over."**
- Expect:
  - `set_turn_hook enabled=false` proposed (confirm each step).
  - `clear_turn_order` proposed.
  - `list_zones` called; `clear_zone` proposed for each zone found.
  - Aura-clear (`set_token_props aura1_radius=0`) proposed for any token with an aura.
  - `sync_character_state` proposed per PC.
  - The After-Action Review runs and its report appears in the Training panel.
- [ ] Pass — each cleanup step has a confirm banner; stray "winding down" did NOT trigger it.
- [ ] AAR report rendered (this is the `onCombatEnd` hook that replaced the phase event).

---

**What still needs a human**: only the parts the automated suite can't reach —
mic capture, Whisper transcription accuracy on real speech, the Electron overlay
render, and the global PTT/confirm hotkeys. The command/backbone **logic** is
covered offline — run `npm test` and trust it on every code change. Do the manual
gem walk-through once to verify the audio/overlay wiring, then re-run it only when
that I/O layer changes.

Per-case automation status:
- **C1** (capability never gated) — automated in `no-phase-regression.test.ts`.
- **C2, C3, C5** (backbones + gate) — automated in `command-backbones.test.ts`;
  the gem walk-through confirms the audio/confirm-banner wiring only.
- **C4** (no turn swallowing) — automated in both files.
