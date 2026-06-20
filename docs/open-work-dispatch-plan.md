# Open-work dispatch plan (Opus orchestrator → parallel Sonnet workers)

A plan for a future **Opus** session to clear the remaining design-doc backlog by **dispatching
independent tracks to parallel Sonnet subagents** (the `Agent` tool), then integrating their PRs.
It exists so the orchestrator doesn't re-derive scope, and so workers don't collide on shared files.

Source of the backlog: the "genuinely open" items found across `docs/`, `skills/`, `voice-hud/`,
`CLAUDE.md`. (The DDB monster mapper that older docs listed as TODO is **done** — see
`docs/ddb-browserless-protocol.md`.)

## Orchestration model

- **One Sonnet worker per track**, each in **its own git worktree** (`Agent` with
  `isolation: "worktree"`) so they never step on each other's working tree.
- **Disjoint file ownership** is the hard rule that makes parallelism safe. The only real contention
  point is **`mod-scripts/ai-relay.js`** (the Mod sandbox dispatch). Exactly **one** worker may touch
  it per wave — the **RELAY** track owns all of it.
- **One PR per track**, base `master`. The orchestrator reviews + merges in the integration order
  below, resolving the (rare) overlap by hand.
- **Live-Mod deploys are the orchestrator's job, post-merge.** Workers validate `ai-relay.js` changes
  against the **emulator** (`test/roll20-emulator.ts` runs the real `ai-relay.js` in a `vm`), never a
  live campaign. After an `ai-relay.js` change merges, the orchestrator redeploys via
  `deploy_mod_script` (now clobber-safe) and runs `tsx src/recon/soak-test.ts` (per `CLAUDE.md`).

### Cross-cutting rules every worker is told
1. `npx tsc --noEmit` and `npx vitest run` MUST pass before opening the PR. (The `combat-round` suite
   mocks `getMonster` to stay deterministic/offline — keep it that way.)
2. **Never commit `data/`** — gitignored, holds live credentials/artifacts.
3. Touch only the files in your track's **Owns** list. If you think you need a shared file
   (`ai-relay.js`, `combat.ts`), stop and flag it for the orchestrator instead of editing it.
4. `ai-relay.js` changes: validate via `test/relay-actions.test.ts` (emulator). Do **not** deploy to
   any live game. Keep the three hand-synced condition→marker tables in sync if you touch markers.
5. `voice-hud/` is **not in the root CI** (separate build) — typecheck with `voice-hud/tsconfig.json`
   and note that final verification needs a human to launch the gem.

---

## Wave 1 — parallel Sonnet workers (disjoint areas)

| Track | Goal | Owns (files) | Spec / source | Acceptance |
|---|---|---|---|---|
| **VHUD** | Build the **phase-aware combat HUD agent** | `voice-hud/` only | `voice-hud/WORKFLOW.md` (build spec), `voice-hud/TEST-PLAN.md` | Phases scaffolded in `agent.ts` + phase-scoped prompts per WORKFLOW.md; `voice-hud/tsconfig` clean; TEST-PLAN cases enumerated for human run |
| **LINT** | Pin a lint config | `eslint.config.*`/`.eslintrc*`, `package.json` (devDep + `lint` script), `.github/workflows/ci.yml` | `docs/build-and-test-plan.md:39` | ESLint enforces no-var/prefer-const (codebase already conforms → zero churn); `npm run lint` clean; CI runs it |
| **PCBAR** | Enforce "never write a PC bar" on the single-target HP path | `src/tools/combat.ts` (single-target `update_token_hp` only) + a new `test/` case | `docs/choreography.md:146` | Single-target route honors `isPcToken`/controlledby → relay state (like `resolve_aoe` does); emulator test proves a PC bar is never written; **verify first** — may already hold |
| **RELAY** | Two `ai-relay.js`-touching features (one worker owns the Mod file) | `mod-scripts/ai-relay.js`, a new `src/tools/characters-edit.ts`, `src/server-combat.ts` (register), `test/relay-actions.test.ts` | `docs/roll20-api-coverage.md` (char stub) + `docs/relay-payload-slimming.md` | (a) full **character editing** action (name/bio/avatar/controlledby/archived/inplayerjournals) + a `set_character_props` tool; (b) finish the **payload-slimming** drops still flagged (e.g. `ddb_list_campaigns` `JSON.stringify`). Emulator tests pass. **Flag for orchestrator: needs Mod redeploy + soak after merge.** |

**IMG (optional, design-gated):** an image-generation tool (`docs/security.md:140`) needs a provider
decision (which API, auth, cost) before code. Either the orchestrator scopes it into a spec first, or
defer. Not a clean parallel start until designed.

## Wave 2 — sequential, high-risk (run ALONE, after Wave 1 merges)

These touch the relay/bridge deeply and have no parallel-safe partition — do them one at a time with
full attention, the emulator as the regression net, and a Mod redeploy + soak after each.

| Track | Goal | Spec | Why sequential |
|---|---|---|---|
| **BRIDGE** | Migrate GM bridge-state + turn-hook narration to TS | `docs/bridge-state-and-turn-hook-plan.md` (has "Open questions for next session") | High value/risk; single-writer-per-carrier-token constraint; relay + bridge co-change; needs soak |
| **HANDLERMAP** | Refactor `ai-relay.js` dispatch switch → handler-map | `docs/decisions.md:104` (deferred) | Rewrites ~1,300 lines of dispatch; conflicts with **everything** relay → must be last, after RELAY lands and `test/relay-actions.test.ts` covers the actions it migrates |

## Integration order (orchestrator)
1. Merge **LINT**, **PCBAR**, **VHUD** in any order (disjoint).
2. Merge **RELAY** → redeploy `ai-relay.js` (`deploy_mod_script`) → `tsx src/recon/soak-test.ts`.
3. Then **BRIDGE** (alone) → redeploy + soak.
4. Then **HANDLERMAP** (alone, last) → redeploy + soak. The emulator suite is the regression net.

## Dispatch checklist for the Opus session
- For each Wave-1 track: `Agent(subagent_type: "general-purpose", isolation: "worktree", run_in_background: true)` with the track's Goal + Owns + Acceptance + cross-cutting rules pasted in, and a pointer to the spec doc.
- Collect each worker's PR; run the cross-cutting gate (`tsc`, `vitest`) yourself before merge.
- Do **not** parallelize Wave 2; do **not** let two workers touch `ai-relay.js` in the same wave.
