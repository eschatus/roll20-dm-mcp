# Build & test plan — making it grown up

Current state (2026-06-20): vitest is wired (`npm test`); **18 test files** now exist across
`src/**` and `test/` (campaigns, characters, dndbeyond, tactics, markers, relayState, rt-helpers,
transport-health, relay-fallback, player-commands, combatHelpers, aoe, plus `test/` integration
suites: relay-actions, tactics-live-eval, current-page, combat-round, aoe-resolve, hp-init); tsc
build; **CI is wired** (`.github/workflows/ci.yml`); no ESLint config checked in. The RTDB
transport now has unit coverage (`rt-helpers.test.ts`); live `src/recon/*` scripts remain the
manual real-campaign smoke layer. This plan tracks what's done and what remains.

## Principles

- **Separate pure logic from I/O.** Pure functions (parsing, formatting, marker/HP math) are unit-
  tested in isolation; the thin Firebase/Playwright I/O layer is exercised by the live recon
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

## Phase B — build/CI hygiene  (mostly ✅ DONE)

- ✅ `.github/workflows/ci.yml`: `npm ci` → `tsc --noEmit` → `npm test` → `npm run build` on push/PR,
  plus `node --check mod-scripts/ai-relay.js` as a Mod syntax gate.
- ❌ ESLint config + `npm run lint` in CI — **still not done** (no eslint config at repo root, no
  `lint` script). The codebase already follows no-var/let-const; pinning it remains a TODO.
- ✅ `tsconfig` excludes `src/recon/**` and `src/**/*.test.ts` from the prod build (both already in
  the `exclude` array); recon scripts stay runnable via `tsx`.

## Phase A2 — unit tests for the REST of the codebase ("all functions")  (partially ✅ DONE)

Beyond the new RTDB code, cover the pure logic everywhere:
- ✅ `dndbeyond.ts`: `getMaxHp`/`getCurrentHp`, `parseStats` — covered by `dndbeyond.test.ts`.
- ✅ `combat.ts` helpers: PC-vs-NPC routing, HP-application math — covered by `combatHelpers.test.ts`;
  AoE save/damage logic covered by `aoe.test.ts`.
- 🟡 `tactics.ts` — has `tactics.test.ts`; extend to tier/cascade selection edges.
- 🟡 Mod (`ai-relay.js`) pure helpers — `test/relay-actions.test.ts` runs a Roll20 emulator over the
  relay; full port-mirror vector coverage (shared test set guarding TS `rt-helpers` vs the Mod copy)
  is still partial.

## Phase C — integration tests: prove the pumps are clean (LIVE, gated by env)

Goal the DM asked for: an end-to-end test that **synchronizes DDB ↔ Roll20 and asserts the data
flow is clean**. Gated behind `RUN_LIVE_IT=1` (needs DDB cobalt + Roll20 session); never in plain CI.
- **DDB → MCP read pump:** `getCharacterStats(ddbId)` returns coherent HP/AC/saves/skills for a known
  PC; assert invariants (maxHp ≥ current, conMod applied, proficiency math).
- **MCP → Roll20 write pump:** reflect that PC's tracked HP into its Roll20 token (gmnotes PCHP block)
  via the RT transport; read it back via BOTH the socket and the Mod; assert all three agree.
- **Round-trip cleanliness:** damage the PC through the relay, re-read from Roll20, confirm the
  number matches the math — and confirm DDB was NOT mutated (read-only contract).
- Uses a dedicated TEST PC/token (configurable id) so it never touches a live character.
- Also a mocked-RTDB unit harness (no creds) for `tryDirectRead`/`tryDirectWrite` path+payload shape,
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
  silent success, never a crash that wedges the sandbox); fall-back paths (RT → browser) are reached.
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
   the combat RT relay never changes transport. The same-nonce idempotency machinery still exists
   (nonce generated once per command, deduplicated by the Mod's `PROCESSED_NONCES` LRU) but only
   guards the explicit `ROLL20_TRANSPORT=browser` path's internal retries. `relay-fallback.test.ts`
   was rewritten to verify nonce/transport pass-through only.

2. **`getCharacterStats`/`getRawCharacter` can't read player-owned DDB characters (403).** They use
   the direct character-service API, which only serves characters the account owns or that are
   public; `getCharacter` already has a browser-page fallback for this — the stats readers don't.
   **Fix:** give the stats readers the same 403→browser-fetch fallback (coordinate with the
   `feat/ddb-browserless` work). Until then the DDB→Roll20 integration test skips on 403.

## Keep as the live smoke layer

`src/recon/*` stays the manual pre-deploy smoke/soak layer; `soak-test.ts` is the canonical
end-to-end gate to run after ANY Mod change before relying on it live.

## Phase E — release hygiene (later)

- A `CONTRIBUTING`/`README` build section: `npm ci`, `npm test`, `npm run build`, how to run a soak.
- Mod (`ai-relay.js`) is plain JS in the sandbox — add `node --check` to CI as a syntax gate, and a
  note that Mod changes require redeploy + `soak-test.ts` before relying on them live.
