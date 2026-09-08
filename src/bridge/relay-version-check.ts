import { EXPECTED_RELAY_VERSION } from "./relay-version.js";

// Reported once a version mismatch is detected; null while unchecked or matching. Read by
// src/tools/transport.ts so `transport_status` surfaces it to whoever's diagnosing the gem —
// the DM-visible channel for a clash that isn't caught by any other tool result.
export interface RelayVersionMismatch { expected: string; found: string }
let _mismatch: RelayVersionMismatch | null = null;
let _probeStarted = false;

// Which Roll20 Mod Script Sandbox the campaign runs on, as reported by ACTIONS["ping"]. Roll20
// flipped the default from v1.0 to v1.5 on 2026-09-02 for any game that never explicitly picked
// one, and the two are a behavioral fork (Beacon character sheets above all). Like the relay
// version, this is PER-CAMPAIGN drift a DM cannot see from inside the gem, so transport_status
// carries it. `null` while unprobed; `sandbox: null` inside means the deployed relay predates the
// echo (relay < 2.6.0) — an old relay, not an old sandbox.
export interface RelaySandboxInfo {
  sandbox: string | null;
  node: string | null;
  sheetName: string | null;
  beacon: boolean | null;
}
let _sandbox: RelaySandboxInfo | null = null;

export function getRelayVersionMismatch(): RelayVersionMismatch | null {
  return _mismatch;
}

export function getRelaySandboxInfo(): RelaySandboxInfo | null {
  return _sandbox;
}

// Both handshakes this module holds — the relay version and the sandbox info — describe ONE
// campaign, and both are latched for the life of the process behind _probeStarted. Switching the
// active campaign therefore has to drop them, or transport_status keeps reporting the campaign we
// just left: its relay version, its sandbox, its Beacon flag. (The relay-version half had this
// staleness before the sandbox fields existed; it is fixed here for both.) The next relayCommand
// re-arms the probe via ensureRelayVersionChecked.
export function resetRelayProbeForCampaignSwitch(): void {
  _mismatch = null;
  _sandbox = null;
  _probeStarted = false;
}

// Test-only reset (same shape as transport-health.ts's resetHealth/_resetForTest).
export function _resetRelayVersionCheckForTest(): void {
  _mismatch = null;
  _sandbox = null;
  _probeStarted = false;
}

// Records what the relay said about its sandbox. Purely informational — unlike the relay-version
// handshake there is nothing to be "out of date" against, so this never warns; it exists so a
// diagnosis has the number instead of a guess.
export function reportRelaySandbox(res: {
  sandbox?: string | null; node?: string | null; sheetName?: string | null; beacon?: boolean;
} | null | undefined): void {
  if (!res) return;
  _sandbox = {
    sandbox: res.sandbox ?? null,
    node: res.node ?? null,
    sheetName: res.sheetName ?? null,
    // null, not false: a relay older than 2.6.0 doesn't send this field at all, and reporting a
    // confident "no Beacon sheet here" for a relay that was never asked is worse than saying
    // nothing. `sandbox: null` has the same meaning and the doc says so.
    beacon: typeof res.beacon === "boolean" ? res.beacon : null,
  };
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
      rtRelayCommand<{
        pong?: boolean; version?: string;
        sandbox?: string | null; node?: string | null; sheetName?: string | null; beacon?: boolean;
      }>({ action: "ping" }, { probe: true, timeoutOverrideMs: 6_000 }),
    )
    .then((res) => { reportRelayVersion(res?.version); reportRelaySandbox(res); })
    .catch(() => { /* transport failure — not this check's concern, see comment above */ });
}
