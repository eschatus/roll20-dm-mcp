# Voice HUD — Test Plan

Run this when you sit down with the gem. **Scope right now:** the narration rule change
(assistant reports mechanics + ≤1 line of color; the DM owns the story). The phase workflow in
[`WORKFLOW.md`](WORKFLOW.md) is **not built yet** — its section at the bottom is here so the plan is
ready, but **skip it** until the phase scaffolding lands.

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

## 3. FUTURE — phase workflow (DO NOT RUN until the phase scaffolding is built)

Placeholder cases for when [`WORKFLOW.md`](WORKFLOW.md) is implemented (build steps 1–4):

- [ ] **P1 scene-set** — opening narration with keywords ("...atop Mount Baratok in Curse of
  Strahd... surprised... vampires... wolves... swarms of bats") → confirms campaign, **verifies**
  page (doesn't navigate off your board), matches + reports the cast GM-only, flags "surprised",
  pushes **nothing** to players.
- [ ] **P2 init-prep** — on "roll initiative", NPCs join via `roll_initiative npcOnly clearFirst=
  false` (overlaps get epithets), nameplates on (player-visible), `plan_all_tactics` kicked off,
  **PC initiative untouched** while players fuss.
- [ ] **P3 begin** — on "sort it / start", turn hook on, settled order read back, first turn +
  tactics surfaced.
- [ ] **P4 idle scoping** — out of combat, asking for damage does nothing mechanical (HP tools not
  in the idle allowlist); lookups + journal still work.
- [ ] **P5 explicit exit** — only an explicit close phrase fires cleanup; cleanup steps each prompt
  to confirm; a stray "the fight feels over" does **not** trigger it.
- [ ] **P6 gem phase indicator** — the gem shows the current phase; a misdetected entry is visible
  and correctable.
