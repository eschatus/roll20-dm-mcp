# Build & test plan — making it grown up

Current state (2026-08-26, v2.0.0): vitest is wired (`npm test`); **34 test files** exist across
`src/**` (11: campaigns, characters, dataDir, markers, relayState, rt-helpers, roll20-rt.chat,
transport-health, relay-fallback, combatHelpers, aoe) and `test/` (23 integration suites over the
Roll20 emulator: relay-actions, relay-actions-smoke, relay-transport, relay-version, combat-round,
aoe-resolve, hp-init, hp-threshold-automation, dying-concentration, initiative-entries,
sidekick-routing, pc-bar-invariant, mob-plan-seam, post-roll, token-creation, map-relay,
journal-folder, marker-tables, current-page, tool-helpers, build-version, zone-semantics,
zone-targeting). tsc build; **CI is wired and gates lint** (`.github/workflows/ci.yml`:
`npm ci` → `npm run lint` → `tsc --noEmit` → `npm test` → `npm run build` → `node --check`
on `ai-relay.js`). Live `src/recon/*` scripts remain the manual real-campaign smoke layer.
This plan tracks what's done and what remains.

> **Scope note (v2.0.0).** The suites this plan once listed for `dndbeyond`, `tactics` and
> `player-commands` are gone with the code — the DDB bridge moved to **beyond-mcp** (#171 Phase 2),
> tactics planning and player `!`-command answering moved to the **gem** (this server only stores
> mob plans and forwards chat as SSE), and the gem's own suites left with it on 2026-08-11.
> There is also **no Playwright anywhere** (#179), so every "browser path" in the phases below is
> dead; the only I/O layer left to fake is Firebase RTDB.

## Principles

- **Separate pure logic from I/O.** Pure functions (parsing, formatting, marker/HP math) are unit-
  tested in isolation; the thin Firebase RTDB I/O layer is exercised by the live recon
  scripts (manual) and, later, a small mocked-RTDB integration test.
- **Tests beside source** (`src/**/*.test.ts`), node env, deterministic (no network, no clock
  flakiness — inject/clamp time where needed).
- **CI gates merges:** typecheck + test + build must pass.

## Phase A — unit tests for the new RTDB code (this session's gap) ✅ DONE

Pure helpers were extracted out of `roll20-rt.ts` into `src/bridge/rt-helpers.ts` (exported) and
are covered by `rt-helpers.test.ts` (plus `markers.test.ts`, `relayState.test.ts`):
- `parseAibridge` — marker + balanced-brace JSON extraction (nested braces, strings with braces, malformed). ✅
- `cleanChat` — HTML/rolltemplate/URL stripping, entity decode, 240-char cap. ✅
- `parsePcHpBlock` / `writePcHpBlock` — round-trip, preserve surrounding gmnotes, replace not duplicate. ✅
- `parseTurnorder` — JSON-string vs array vs garbage; drops `_pageid`. ✅
- `mapToken` — lean/status/full profiles; default-fill of missing fields. ✅
- `stripUndefWrite` — drops undefined/NaN, keeps null/0/"". ✅
- `parseBroadcastPing` — live ping payload parse (negated-y). ✅ (added after this plan was drafted)
- `markers.ts` — `resolveMarkerForState` tiers (condition/pseudo/custom), `hashToPool` determinism + stability. ✅
- `relayState.ts` — `trackCustomState`/`getCustomStates` add/remove/prune (temp dir, no real `data/`). ✅

## Phase B — build/CI hygiene  ✅ DONE

- ✅ `.github/workflows/ci.yml`: `npm ci` → `npm run lint` → `tsc --noEmit` → `npm test` →
  `npm run build` on push/PR, plus `node --check mod-scripts/ai-relay.js` as a Mod syntax gate.
- ✅ ESLint config + `npm run lint` in CI — **done**: `eslint.config.js` at the repo root,
  `"lint": "eslint src/**/*.ts test/**/*.ts"`, and CI runs it as the first gate.
- ✅ `tsconfig` excludes `src/recon/**` and `src/**/*.test.ts` from the prod build (both already in
  the `exclude` array); recon scripts stay runnable via `tsx`.
- Note: CI **cannot deploy the Mod**. `node --check` proves `ai-relay.js` parses, nothing more —
  deploying is a manual paste into the campaign's API console (#175), so a green CI never implies
  the live relay is current. That is what the `AI_RELAY_VERSION`/`EXPECTED_RELAY_VERSION` handshake
  (`test/relay-version.test.ts`, surfaced by `transport_status`) is for.

## Phase A2 — unit tests for the REST of the codebase ("all functions")  (partially ✅ DONE)

Beyond the new RTDB code, cover the pure logic everywhere:
- ✅ `combat.ts` helpers: PC-vs-NPC routing, HP-application math — covered by `combatHelpers.test.ts`;
  AoE save/damage logic covered by `aoe.test.ts`; the three-way PC/NPC/sidekick split and the
  never-write-a-PC-bar invariant by `test/sidekick-routing.test.ts` + `test/pc-bar-invariant.test.ts`.
- ~~`dndbeyond.ts`~~ / ~~`tactics.ts`~~ — **out of scope**: that code left for beyond-mcp and the gem.
- 🟡 Mod (`ai-relay.js`) pure helpers — `test/relay-actions.test.ts` runs a Roll20 emulator over the
  relay; full port-mirror vector coverage (shared test set guarding TS `rt-helpers` vs the Mod copy)
  is still partial. `test/marker-tables.test.ts` pins the three hand-synced condition→marker copies
  against each other, which is the highest-value slice of that mirror.

## Phase C — integration tests: prove the pumps are clean (LIVE, gated by env)

> **Rewritten for v2.0.0.** The original goal was a DDB ↔ Roll20 sync test. There is no DDB here any
> more (#171 Phase 2) and no `full_sync_character` / `sync_character_state` to test — stats arrive
> caller-supplied (`roll_initiative entries[]`, the token tools). What remains worth proving live is
> the **Roll20 half**, gated behind `RUN_LIVE_IT=1` (needs a furnished `roll20-rt-token.json` for the
> test campaign); never in plain CI.
- **MCP → Roll20 write pump:** write a PC's tracked HP into its Roll20 token (gmnotes PCHP block)
  via the RT transport; read it back via BOTH the direct RTDB read and the Mod relay; assert they agree.
- **Round-trip cleanliness:** damage the PC through the relay, re-read from Roll20, confirm the
  number matches the math — and confirm `bar1` was **not** touched (the PC-bar invariant, live).
- **Credential contract:** with the token file absent / wrong-campaign / stale, every tool fails with
  `Roll20TokenUnavailableError` and **nothing tries to open a browser** (there is none to open).
- Uses a dedicated TEST PC/token (configurable id) so it never touches a live character.
- Also a mocked-RTDB unit harness (no creds) for `tryDirectRead`/`rtCreatePage` path+payload shape,
  so the logic is covered in plain CI even though the live pump test is gated.

## Phase D — UX / scenario tests: no dead ends, no weird state

Drive realistic tool sequences and assert invariants after each step (run against the live campaign
behind a flag, or a mocked relay):
- **Combat lifecycle:** start → roll initiative → advance rounds → apply damage → condition on/off →
  token death (mark dead + move to map layer) → combat end. After each step assert: turn order
  well-formed, no orphaned markers, HP within [0,max], dead tokens on map layer, no silent no-ops.
- **Idempotency / hardening regressions:** same-nonce resend does NOT double-apply; non-GM sender is
  rejected; `undefined`/NaN writes are scrubbed (the Firebase-crash guard) — assert via the relay.
- **Error-path / dead-end audit:** every tool given malformed input returns a clear error (never a
  silent success, never a crash that wedges the sandbox). There is no fall-back path to exercise —
  assert instead that an RT failure **surfaces**, and that an open circuit breaker fast-fails with
  the "reconnect to re-harvest" message rather than hanging for the full timeout.
- **State-diff harness:** snapshot relevant Roll20 state before/after a tool, diff it, and flag any
  unexpected field changes (catches "weird state changes the test didn't anticipate").

## Findings from the first live test run (follow-ups)

The new tests immediately earned their keep — two real issues surfaced:

1. ~~**RT transport falls back to the browser on a *Mod error*, not just a transport failure.**~~
   ✅ **RESOLVED — and the cross-transport fallback was subsequently removed entirely.** RT is now
   the default transport and combat is **browserless with no Playwright fallback**: `relayCommand`'s
   RT branch (`roll20.ts`) re-throws on failure (clear "reconnect to re-harvest the token" error)
   rather than reaching for a browser a packaged install doesn't ship. `shouldFallback` was therefore
   **deleted** (zero references in `src/`); the double-apply hazard it targeted can't arise because
   there is only one transport to change to. The same-nonce idempotency machinery still exists
   (nonce generated once per command, deduplicated by the Mod's `PROCESSED_NONCES` LRU) and now
   guards `rtRelayCommand`'s own in-process retries. `relay-fallback.test.ts` was rewritten to
   verify nonce/transport pass-through only. (Updated 2026-08-26: the browser path referenced in the
   original wording is gone entirely — #122/#179.)

2. ~~**`getCharacterStats`/`getRawCharacter` can't read player-owned DDB characters (403).**~~
   **MOOT (#171 Phase 2)** — those readers, and every `ddb_*` tool, left for **beyond-mcp**. The
   403-on-player-owned-characters finding is still true of the DDB character-service API and now
   belongs to that repo's notes, not this one.

## Keep as the live smoke layer

`src/recon/*` stays the manual pre-deploy smoke/soak layer; `tsx src/recon/soak-test.ts`
(`runSoak()`) is the canonical end-to-end gate to run after ANY Mod change before relying on it
live — relay round-trip, direct RTDB reads/writes, Mod-side PC-HP gmnotes, TS↔Mod consistency,
`batchExec`, conditions, and the dice engine, against one hidden scratch token it deletes
afterwards. It needs a furnished RT token; it launches nothing.

## Phase E — release hygiene (later)

- ✅ `node --check mod-scripts/ai-relay.js` is in CI as a syntax gate.
- 🟡 A `CONTRIBUTING`/`README` build section: `npm ci`, `npm test`, `npm run build`, how to run a soak.
- **Deploy is out of band.** `release:mod` / `deploy_mod_script` were deleted (#175) — the Mod is
  pasted into the campaign's API console by a human, **per campaign**, so two campaigns can run
  different relay versions. Verify the LOAD, not the write: the sandbox banner
  `[GM_AI_Bridge] Relay script loaded (vX.Y.Z)` or a `ping` echoing the version — then soak.
