import { EXPECTED_RELAY_VERSION } from "./relay-version.js";
import { getActiveCampaign } from "../registry/campaigns.js";

// How long to wait before re-probing after a FAILED probe. Without a retry at all, one transient
// failure at startup (RT socket not up yet, credentials mid-refresh) left transport_status
// permanently unprobed and a stale relay permanently undetected for the life of the process.
// Without a cooldown, every relay command while RT is down would fire another probe.
const PROBE_RETRY_COOLDOWN_MS = 30_000;

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

// Everything this module knows describes ONE campaign: its deployed relay, its sandbox, its sheet.
// The active campaign changes at runtime (switch_campaign), so results carry the campaign they
// belong to and go stale the moment it changes. `_probedCampaign` is the campaign the stored
// RESULT is for; `_probeCampaign` is the campaign the last probe was STARTED for (they differ
// while one is in flight, which is what stops an in-flight probe being restarted on every command).
let _probedCampaign: string | null = null;
let _probeCampaign: string | null = null;
let _probeFailedAt = 0;

// The active campaign's Roll20 id, or null when none is configured yet. getActiveCampaign throws
// in that case — "no campaign registered" is a legitimate startup state, not a failure to report,
// and a null here simply means the probe result isn't tied to any campaign.
function currentCampaignId(): string | null {
  try { return getActiveCampaign().roll20CampaignId ?? null; } catch { return null; }
}

// A result gathered from a different campaign is not an answer about this one. Reporting it would
// be worse than reporting nothing, so the getters withhold it rather than mislabel it.
function resultIsStale(): boolean {
  return _probedCampaign !== currentCampaignId();
}

export function getRelayVersionMismatch(): RelayVersionMismatch | null {
  return resultIsStale() ? null : _mismatch;
}

export function getRelaySandboxInfo(): RelaySandboxInfo | null {
  return resultIsStale() ? null : _sandbox;
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
  _probedCampaign = null;
  _probeCampaign = null;
  _probeFailedAt = 0;
}

// Test-only reset (same shape as transport-health.ts's resetHealth/_resetForTest).
export function _resetRelayVersionCheckForTest(): void {
  resetRelayProbeForCampaignSwitch();
}

// Records what the relay said about its sandbox. Purely informational — unlike the relay-version
// handshake there is nothing to be "out of date" against, so this never warns; it exists so a
// diagnosis has the number instead of a guess.
export function reportRelaySandbox(res: {
  sandbox?: string | null; node?: string | null; sheetName?: string | null; beacon?: boolean;
} | null | undefined, campaignId: string | null = currentCampaignId()): void {
  if (!res) return;
  _probedCampaign = campaignId;
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
export function reportRelayVersion(
  found: string | null | undefined,
  campaignId: string | null = currentCampaignId(),
): void {
  if (!found) return;
  // Attribute the answer to the campaign the probe was ISSUED for, not to whatever is active when
  // it lands — a switch mid-probe would otherwise stamp the old relay's version onto the new
  // campaign and stop it ever being re-probed.
  _probedCampaign = campaignId;
  if (found === EXPECTED_RELAY_VERSION || _mismatch) return;
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
  const campaign = currentCampaignId();

  // Already probed (or probing) for THIS campaign: skip, unless the last attempt failed and the
  // retry cooldown has elapsed. `_probeFailedAt === 0` means the probe is in flight or succeeded,
  // and neither wants re-running.
  if (_probeStarted && _probeCampaign === campaign) {
    if (!_probeFailedAt || Date.now() - _probeFailedAt < PROBE_RETRY_COOLDOWN_MS) return;
  }

  // A different campaign than the one we hold an answer for. Drop the answer before probing —
  // switch_campaign calls resetRelayProbeForCampaignSwitch directly for the immediate case, but
  // this catches any other path that changes the active campaign without going through the tool.
  if (_probeCampaign !== campaign) {
    _mismatch = null;
    _sandbox = null;
    _probedCampaign = null;
  }

  _probeStarted = true;
  _probeCampaign = campaign;
  _probeFailedAt = 0;
  import("./roll20-rt.js")
    .then(({ rtRelayCommand }) =>
      rtRelayCommand<{
        pong?: boolean; version?: string;
        sandbox?: string | null; node?: string | null; sheetName?: string | null; beacon?: boolean;
      }>({ action: "ping" }, { probe: true, timeoutOverrideMs: 6_000 }),
    )
    .then((res) => { reportRelayVersion(res?.version, campaign); reportRelaySandbox(res, campaign); })
    .catch(() => {
      // Still not this check's concern to report — liveness is the watchdog's job — but the
      // attempt is remembered so the next command after the cooldown tries again instead of
      // leaving the handshake permanently unprobed.
      _probeFailedAt = Date.now();
    });
}
