# Moved — the DmPhase removal record belongs to `dm-whisper`

Tombstoned 2026-08-26. The change itself was real and is still in force, but everything it touched
is now in the gem's repository: **https://github.com/eschatus/dm-whisper**
(`src/agent.ts`, `src/config.ts`, `test/no-phase-regression.test.ts`,
`test/command-backbones.test.ts`).

**What happened, in one paragraph.** On 2026-07-19 the voice HUD's five-state machine
(`IDLE → SCENE_SET → INIT_PREP → COMBAT_LOOP → CLEANUP`) was deleted. It had been gating **which
tools the model could see** per conversational state, which produced six distinct harms — capability
lockout (HP/condition/AoE tools existed in 1 of 5 phases), turn swallowing, history wipe on
transition, internals leaking into DM-facing text, the model asserting a state it had no tool to
set, and phase entry keyed on word form rather than meaning. Ungating cost nothing measurable:
`eval-arc` held at 21/21 with the schema grown from 37 to 48 tools, and latency did not regress. The
characterization suite that pinned all six harms was inverted into a regression test, so the
behaviour is executably pinned — **in the gem repo**.

**Why it isn't kept here.** This file was written while the gem was still a `voice-hud/`
subdirectory of this repo (it split on 2026-08-11). Every file, test and log path it cites is now
somewhere else, and the "if phases return, that file fails" guarantee is enforced by a test this
repo does not contain. Keeping the full record here only invites the two copies drifting.

## What stays true of THIS repo

- **This server never gates tools by state, and must not start.** It registers a fixed toolset per
  server (`server-combat.ts` / `index-maps.ts`); what a caller may do never depends on what it did
  before. The one piece of conversational state the server *does* hold — mob plans in relay state —
  is data the DM asked for, not a capability gate.
- **Tool-schema size is a real cost, and it is this repo's to manage.** The gate existed because 48
  tools is a lot of distractors for a small local model. The right lever turned out to be *having
  fewer tools*, not *hiding tools*: #171 removed the DDB bridge, the tactics planners and the player
  `!`-command answerers outright. Prefer that lever.
- **The generalizable lesson:** narrowing what a model can see, to make it choose better, hides the
  failure instead of fixing it — and the evaluation that blessed the gate only ever ran inside the
  one phase where everything worked, which is exactly why it never caught the lockout.
