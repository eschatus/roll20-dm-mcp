// ─────────────────────────────────────────────────────────────────────────────
// The relay/sandbox handshake probe's LIFECYCLE — when it runs, when it retries,
// and when its answer stops being true.
//
// Everything the handshake learns (deployed relay version, Mod Script Sandbox
// version, Beacon flag) describes ONE campaign. The active campaign changes at
// runtime, and the probe used to be latched for the life of the process behind a
// single boolean, which produced two failures:
//
//   1. after a campaign switch, transport_status kept reporting the campaign we
//      had just left — its relay version, its sandbox, its Beacon flag
//   2. ONE failed probe (RT socket not up yet at startup, credentials mid-refresh)
//      disabled the handshake permanently: no retry, so a stale deployed relay
//      went undetected for the rest of the process
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { rtRelayMock } = vi.hoisted(() => ({ rtRelayMock: vi.fn() }));

vi.mock("../src/bridge/roll20-rt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bridge/roll20-rt.js")>();
  return { ...actual, rtRelayCommand: rtRelayMock };
});

import {
  ensureRelayVersionChecked, getRelaySandboxInfo, getRelayVersionMismatch,
  reportRelaySandbox, _resetRelayVersionCheckForTest,
} from "../src/bridge/relay-version-check.js";

// The probe reaches its transport through a dynamic import. Loading that module graph for the
// first time takes ~150ms, which no amount of microtask flushing waits for — importing it here
// puts it in the module registry so the probe's import resolves from cache instead.
import "../src/bridge/roll20-rt.js";

/** Let the probe's dynamic import + promise chain settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

const ORIGINAL_CAMPAIGN = process.env.ROLL20_CAMPAIGN_ID;
let now = 1_000_000;

beforeEach(() => {
  _resetRelayVersionCheckForTest();
  rtRelayMock.mockReset();
  process.env.ROLL20_CAMPAIGN_ID = ORIGINAL_CAMPAIGN;
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.ROLL20_CAMPAIGN_ID = ORIGINAL_CAMPAIGN;
});

describe("probe scheduling", () => {
  it("probes once and does not re-probe on later commands", async () => {
    rtRelayMock.mockResolvedValue({ pong: true, version: "9.9.9", sandbox: "1.5", beacon: true });

    ensureRelayVersionChecked();
    await settle();
    ensureRelayVersionChecked();
    ensureRelayVersionChecked();
    await settle();

    expect(rtRelayMock).toHaveBeenCalledTimes(1);
    expect(getRelaySandboxInfo()).toMatchObject({ sandbox: "1.5", beacon: true });
  });

  it("does not re-probe while one is still in flight", async () => {
    // A never-settling probe. Without a separate "started for" record, each command would see
    // no stored result, decide the campaign was unprobed, and fire another probe.
    rtRelayMock.mockImplementation(() => new Promise(() => {}));

    ensureRelayVersionChecked();
    ensureRelayVersionChecked();
    ensureRelayVersionChecked();
    await settle();

    expect(rtRelayMock).toHaveBeenCalledTimes(1);
  });
});

describe("retry after a failed probe", () => {
  it("does not retry inside the cooldown", async () => {
    rtRelayMock.mockRejectedValue(new Error("socket down"));

    ensureRelayVersionChecked();
    await settle();
    expect(rtRelayMock).toHaveBeenCalledTimes(1);

    now += 29_000;
    ensureRelayVersionChecked();
    await settle();
    expect(rtRelayMock).toHaveBeenCalledTimes(1);
  });

  it("retries once the cooldown has elapsed, and recovers", async () => {
    rtRelayMock.mockRejectedValueOnce(new Error("socket down"));

    ensureRelayVersionChecked();
    await settle();
    expect(getRelaySandboxInfo()).toBeNull();

    // A transient startup failure must not disable the handshake for the life of the process.
    rtRelayMock.mockResolvedValue({ pong: true, version: "9.9.9", sandbox: "1.0", beacon: false });
    now += 31_000;
    ensureRelayVersionChecked();
    await settle();

    expect(rtRelayMock).toHaveBeenCalledTimes(2);
    expect(getRelaySandboxInfo()).toMatchObject({ sandbox: "1.0", beacon: false });
    expect(getRelayVersionMismatch()).toMatchObject({ found: "9.9.9" });
  });
});

describe("results are campaign-scoped", () => {
  it("withholds a result gathered under a different campaign", () => {
    reportRelaySandbox({ sandbox: "1.5", beacon: true });
    expect(getRelaySandboxInfo()).toMatchObject({ sandbox: "1.5" });

    // Reporting the previous campaign's sandbox as this one's would be worse than reporting
    // nothing — the DM would redeploy against a number that was never about this campaign.
    process.env.ROLL20_CAMPAIGN_ID = "some-other-campaign";
    expect(getRelaySandboxInfo()).toBeNull();
    expect(getRelayVersionMismatch()).toBeNull();
  });

  it("re-probes when the active campaign changes without going through switch_campaign", async () => {
    rtRelayMock.mockResolvedValue({ pong: true, version: "9.9.9", sandbox: "1.5", beacon: true });
    ensureRelayVersionChecked();
    await settle();
    expect(rtRelayMock).toHaveBeenCalledTimes(1);

    // switch_campaign calls resetRelayProbeForCampaignSwitch directly, but nothing guarantees
    // every path that changes the active campaign goes through that tool.
    rtRelayMock.mockResolvedValue({ pong: true, version: "9.9.9", sandbox: "1.0", beacon: false });
    process.env.ROLL20_CAMPAIGN_ID = "some-other-campaign";
    ensureRelayVersionChecked();
    await settle();

    expect(rtRelayMock).toHaveBeenCalledTimes(2);
    expect(getRelaySandboxInfo()).toMatchObject({ sandbox: "1.0", beacon: false });
  });
});
