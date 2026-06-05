# Build & test plan — making it grown up

Current state: vitest is wired (`npm test`), 4 test files exist (campaigns, characters, dndbeyond,
tactics), tsc build, no CI, no lint config checked in. The RTDB transport added this session has
**zero unit coverage** (only live `src/recon/*` scripts, which hit the real campaign). This plan
closes those gaps.

## Principles

- **Separate pure logic from I/O.** Pure functions (parsing, formatting, marker/HP math) are unit-
  tested in isolation; the thin Firebase/Playwright I/O layer is exercised by the live recon
  scripts (manual) and, later, a small mocked-RTDB integration test.
- **Tests beside source** (`src/**/*.test.ts`), node env, deterministic (no network, no clock
  flakiness — inject/clamp time where needed).
- **CI gates merges:** typecheck + test + build must pass.

## Phase A — unit tests for the new RTDB code (this session's gap) ✅ doing now

Extract the pure helpers out of `roll20-rt.ts` into `src/bridge/rt-helpers.ts` (exported) and test:
- `parseAibridge` — marker + balanced-brace JSON extraction (nested braces, strings with braces, malformed).
- `cleanChat` — HTML/rolltemplate/URL stripping, entity decode, 240-char cap.
- `parsePcHpBlock` / `writePcHpBlock` — round-trip, preserve surrounding gmnotes, replace not duplicate.
- `parseTurnorder` — JSON-string vs array vs garbage; drops `_pageid`.
- `mapToken` — lean/status/full profiles; default-fill of missing fields.
- `stripUndefWrite` — drops undefined/NaN, keeps null/0/"".
- `markers.ts` — `resolveMarkerForState` tiers (condition/pseudo/custom), `hashToPool` determinism + stability.
- `relayState.ts` — `trackCustomState`/`getCustomStates` add/remove/prune (temp dir, no real `data/`).

## Phase B — build/CI hygiene

- `.github/workflows/ci.yml`: `npm ci` → `tsc --noEmit` → `npm test` → `npm run build` on push/PR.
- Add ESLint config (the codebase already follows no-var/let-const; pin it) + `npm run lint` in CI.
- `tsconfig`: exclude `src/recon/**` from the prod build (dev-only live scripts that import bridges);
  keep them runnable via `tsx`. Likewise keep `*.test.ts` out of `dist` (already handled).

## Phase A2 — unit tests for the REST of the codebase ("all functions")

Beyond the new RTDB code, cover the pure logic everywhere:
- `dndbeyond.ts`: `getMaxHp`/`getCurrentHp` (Con-mod HP math, override paths), `parseStats`
  (ability mods, proficiency/expertise, saves/skills, init, passive perception) — table-driven.
- `combat.ts` helpers: PC-vs-NPC routing, HP-application math, name/target resolution.
- `tactics.ts` (has a test — extend to the tier/cascade selection edges).
- Mod (`ai-relay.js`) pure helpers: port-mirror tests for `cleanChat`, `resolveMarkerForState`,
  `hashToPool`, `bboxOf`, `makeCirclePath`, `normProps`, `stripUndef` (the TS `rt-helpers` versions
  are kept byte-compatible, so one shared test vector set guards BOTH copies against drift).

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

1. **RT transport falls back to the browser on a *Mod error*, not just a transport failure.**
   `roll20.ts` `relayCommand` treats ANY `rtRelayCommand` rejection as a transport failure and
   retries via the Playwright relay. But a legitimate Mod validation error (e.g. "no properties to
   set") is a *successful* round-trip that the Mod chose to reject — re-running it via the browser is
   wasteful and, for a mutating command that errored post-partial-write, risks a double-apply (the
   browser fallback uses a fresh nonce, bypassing the idempotency cache). **Fix:** tag Mod-returned
   errors distinctly (e.g. a `RelayModError`) and have the fallback re-throw those instead of
   retrying; only fall back on real transport failures (timeout/auth/disconnect).

2. **`getCharacterStats`/`getRawCharacter` can't read player-owned DDB characters (403).** They use
   the direct character-service API, which only serves characters the account owns or that are
   public; `getCharacter` already has a browser-page fallback for this — the stats readers don't.
   **Fix:** give the stats readers the same 403→browser-fetch fallback (coordinate with the
   `feat/ddb-browserless` work). Until then the DDB→Roll20 integration test skips on 403.

## Keep as the live smoke layer

`src/recon/*` stays the manual pre-deploy smoke/soak layer; `soak-test.ts` is the canonical
end-to-end gate to run after ANY Mod change before relying on it live.

## Phase D — release hygiene (later)

- A `CONTRIBUTING`/`README` build section: `npm ci`, `npm test`, `npm run build`, how to run a soak.
- Mod (`ai-relay.js`) is plain JS in the sandbox — add `node --check` to CI as a syntax gate, and a
  note that Mod changes require redeploy + `soak-test.ts` before relying on them live.
