import { EXPECTED_RELAY_VERSION } from "./relay-version.js";

// Reported once a version mismatch is detected; null while unchecked or matching. Read by
// src/tools/transport.ts so `transport_status` surfaces it to whoever's diagnosing the gem —
// the DM-visible channel for a clash that isn't caught by any other tool result.
export interface RelayVersionMismatch { expected: string; found: string }
let _mismatch: RelayVersionMismatch | null = null;
let _probeStarted = false;

export function getRelayVersionMismatch(): RelayVersionMismatch | null {
  return _mismatch;
}

// Test-only reset (same shape as transport-health.ts's resetHealth/_resetForTest).
export function _resetRelayVersionCheckForTest(): void {
  _mismatch = null;
  _probeStarted = false;
}

// Compares a version the relay actually reported (from ACTIONS["ping"]'s `version` field) against
// what this build expects, and reports a mismatch loudly, exactly once per process.
//
// WARN, not throw: a version clash means the deployed Mod script is stale or from the wrong
// branch/working tree — real drift worth flagging, but not a reason to fail every in-flight tool
// call. Most relay actions still work fine against an older Mod (the ai-relay ACTIONS map is
// additive far more often than breaking), and mid-combat is the worst possible moment to turn a
// "your build is a bit stale" notice into a hard failure. A DM who gets a clear warning can finish
// the fight and redeploy after; a DM who gets an exception mid-initiative cannot. If a specific
// relay action ever needs a hard version floor, that's a decision for that action's call site, not
// this handshake.
export function reportRelayVersion(found: string | null | undefined): void {
  if (!found || found === EXPECTED_RELAY_VERSION || _mismatch) return;
  _mismatch = { expected: EXPECTED_RELAY_VERSION, found };
  console.error(
    `[roll20] Roll20 relay is out of date — found ${found}, expected ${EXPECTED_RELAY_VERSION}. ` +
    `The deployed Mod script (mod-scripts/ai-relay.js) doesn't match this server build — likely ` +
    `deployed from the wrong branch or working tree. Run "npm run release:mod" from the checkout ` +
    `with the build you intend to run, then reconnect Roll20. (Also visible via transport_status.)`,
  );
}

// Fire-and-forget, once per process: probes the relay's version over RT (the same cheap "ping"
// action the watchdog already uses for liveness) and reports any mismatch via reportRelayVersion.
// Deliberately NOT awaited by callers — must never add latency to a real command — and a failed or
// timed-out probe is silently dropped: liveness is the watchdog/circuit-breaker's job, not this
// check's; we only care about the version when the sandbox is already answering.
export function ensureRelayVersionChecked(): void {
  if (_probeStarted) return;
  _probeStarted = true;
  import("./roll20-rt.js")
    .then(({ rtRelayCommand }) =>
      rtRelayCommand<{ pong?: boolean; version?: string }>({ action: "ping" }, { probe: true, timeoutOverrideMs: 6_000 }),
    )
    .then((res) => reportRelayVersion(res?.version))
    .catch(() => { /* transport failure — not this check's concern, see comment above */ });
}
