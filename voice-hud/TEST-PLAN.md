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

## 3. Phase workflow (scaffolding is now built — run to verify)

**NOTE: These cases require the Electron gem to be running** — launch via
`voice-hud\launch-gem.vbs` (or `launch-gem.cmd`) and complete the section-0
preconditions first. The gem must be connected to a live Roll20 campaign with
tokens on the board.

### Setup for phase tests
- Be in **curse-of-strahd** (or any registered campaign).
- Have at least 3 NPC tokens + 2 PC tokens on the current page, turn tracker empty.
- Tick "show tool activity" in the ledger so you can see which tools fire.
- Confirm the gem shows **IDLE** in the phase badge (top of gem, or check the Debug
  tab via `getPhase()`).

---

### P1 — Scene-set: fuzzy entry from opening narration
- Say: **"The party finds themselves atop Mount Baratok in the Curse of Strahd,
  and are surprised when suddenly they're beset by several vampires and many
  children of the night represented by wolves and swarms of bats."**
- Expect:
  - Phase transitions IDLE → SCENE_SET (badge updates, log line `phase: IDLE → SCENE_SET`).
  - Gem calls `active_campaign` / `switch_campaign` (only if wrong campaign).
  - Gem calls `get_current_page` — **verifies** map, does NOT call any page-navigation tool.
  - Gem calls `list_tokens` — reports cast GM-only ("Found 3 Vampire Spawn…").
  - Gem surfaces "Party surprised — hold their round-1 turns?" as a question to DM.
  - **Nothing** pushed to players (no `send_narration`).
- [ ] Pass — phase badge shows SCENE_SET; cast report visible; no player output.

### P2 — Init-prep: NPC initiative roll on "roll initiative"
- While in SCENE_SET, say: **"Roll initiative."**
- Expect:
  - Phase transitions SCENE_SET → INIT_PREP.
  - `roll_initiative` called with `npcOnly=true`, `clearFirst=false` (confirm banner appears).
  - After confirm: NPCs appear in the Roll20 turn order; player entries untouched.
  - `plan_all_tactics` called (confirm banner — tactics queue up).
  - Gem notes "Call 'sort it / start' when players have settled."
- [ ] Pass — turn order shows NPCs only added; players did not lose their entries.
- [ ] `clearFirst=false` confirmed in the tool call args (check ledger).

### P3 — Begin combat: "sort it / start"
- While in INIT_PREP, say: **"Sort it, let's start."**
- Expect:
  - Phase transitions INIT_PREP → COMBAT_LOOP.
  - `set_turn_hook` called with `enabled=true` (confirm banner).
  - `get_turn_order` called immediately after — settled order read back.
  - Gem surfaces first turn + its queued tactical plan.
- [ ] Pass — phase badge shows COMBAT_LOOP; first combatant named.

### P4 — Idle scoping: HP tools blocked while IDLE
- **Reset to IDLE**: restart the gem (or in a fresh session before any narration).
- While in IDLE, say: **"The goblin takes 7 damage."**
- Expect: gem says it cannot apply HP changes out of combat (or gently declines), does
  **not** call `update_token_hp` or `update_hp_many`. Read tools (list_tokens,
  ddb_get_monster, etc.) still work.
- [ ] Pass — no HP tool called in IDLE; toolset is read-only.

### P5 — Explicit exit: cleanup fires only on deliberate phrase
- While in COMBAT_LOOP, say: **"The fight feels like it might be winding down."**
- Expect: NO cleanup triggered. Normal agent turn runs.
- [ ] Pass — "feels like winding down" does NOT trigger cleanup.

- Then say: **"Combat's over."**
- Expect:
  - Phase transitions COMBAT_LOOP → CLEANUP → IDLE.
  - `set_turn_hook enabled=false` proposed (confirm each step).
  - `clear_turn_order` proposed.
  - `list_zones` called; `clear_zone` proposed for each zone found.
  - Aura-clear (`set_token_props aura1_radius=0`) proposed for any token with an aura.
  - `sync_character_state` proposed per PC.
  - Phase returns to IDLE after cleanup finishes.
- [ ] Pass — each cleanup step has a confirm banner; stray "winding down" did NOT trigger it.

### P6 — Phase indicator visible in gem
- At each phase transition (IDLE→SCENE_SET→INIT_PREP→COMBAT_LOOP→CLEANUP→IDLE), the
  gem must display or log the current phase so a misdetected entry is visible and
  correctable. Check via:
  - The Debug log panel (look for `[agent] phase: X → Y` lines).
  - The `phase` IPC event (add a temporary `console.log` in gem.js `onPhaseChange` callback if needed).
- [ ] Pass — all five transitions logged; DM can see where the state machine is.

---

**Human verification required**: All P1–P6 cases need the live Electron gem + Roll20
browser open. The Electron gem cannot be launched headlessly by automated tests — a
human must sit at the table and walk through each case. Check off each box above as you
verify it manually.
