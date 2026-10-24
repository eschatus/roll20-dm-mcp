// No-silent-fallback guard (#83/#84).
//
// The emulator harness routes through __setBridgeTestTransport, so it can't exercise
// relayCommand's real RT dispatch. This test mocks the RT layer and the (deleted) browser
// bridge directly to assert: relayCommand always goes to RT — there is no env var or other
// switch that selects anything else (#180 removed the last one, ROLL20_TRANSPORT/rtEnabled()) —
// and an RT failure surfaces an actionable error WITHOUT ever touching a browser.

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above imports — define the spies via vi.hoisted so they exist first.
const { rtRelayMock, getPageMock, newPageMock } = vi.hoisted(() => ({
  rtRelayMock: vi.fn(),
  getPageMock: vi.fn(async () => { throw new Error("BROWSER PATH REACHED — must not happen under RT"); }),
  newPageMock: vi.fn(async () => { throw new Error("BROWSER PATH REACHED — must not happen under RT"); }),
}));

vi.mock("../src/bridge/roll20-rt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bridge/roll20-rt.js")>();
  return { ...actual, rtRelayCommand: rtRelayMock };
});

// There is no browser bridge module in this repo any more (#122/#179) — this mocks the path a
// hidden fallback would have to reach for, so one reappearing would fail loudly instead of
// silently resolving to nothing.
vi.mock("../src/bridge/browser.js", () => ({
  getPage: getPageMock,
  newBrowserPage: newPageMock,
  closeBrowser: vi.fn(),
}));

import { relayCommand } from "../src/bridge/roll20.js";
import { RtPreSendError, RtModSilentError, RtRelayError } from "../src/bridge/roll20-rt.js";
import { getActiveCampaign } from "../src/registry/campaigns.js";

describe("relay transport — browserless RT, no silent fallback (#83/#84)", () => {
  beforeEach(() => { rtRelayMock.mockReset(); getPageMock.mockClear(); newPageMock.mockClear(); });

  it("routes through RT and returns its result, never opening a browser", async () => {
    rtRelayMock.mockResolvedValue({ ok: true });
    const res = await relayCommand({ action: "getTokens", pageId: "p1" });
    expect(res).toEqual({ ok: true });
    expect(rtRelayMock).toHaveBeenCalledTimes(1);
    expect(getPageMock).not.toHaveBeenCalled();
    expect(newPageMock).not.toHaveBeenCalled();
  });

  it("on RT failure throws an actionable error and does NOT fall back to the browser", async () => {
    rtRelayMock.mockRejectedValue(new RtPreSendError("rt pre-send (getConn): socket down"));
    await expect(relayCommand({ action: "getTokens" }))
      .rejects.toThrow(/does not fall back to a browser|reconnect roll20/i);
    expect(getPageMock).not.toHaveBeenCalled();
    expect(newPageMock).not.toHaveBeenCalled();
  });
});

// #234: three different failures used to share one remedy, "re-harvest the token". Only the
// first is a credential problem; following that advice for the other two loops the DM.
describe("relay failure remedies (#234)", () => {
  beforeEach(() => { rtRelayMock.mockReset(); });

  it("could not reach the campaign: keeps the reconnect remedy and the gem's token phrase", async () => {
    rtRelayMock.mockRejectedValue(new RtPreSendError(
      "rt pre-send (getConn): No usable Roll20 realtime token for campaign 21660022 (no token file)"));
    const err = await relayCommand({ action: "ping" }).catch((e: Error) => e);
    expect(String(err)).toMatch(/reconnect roll20/i);
    // dm-whisper re-harvests on this phrase; it must survive the reshaping.
    expect(String(err)).toMatch(/no usable roll20 realtime token/i);
  });

  it("reached the campaign but the Mod never replied: points at the API sandbox, not the token", async () => {
    rtRelayMock.mockRejectedValue(new RtModSilentError("ping", 8000));
    const err = String(await relayCommand({ action: "ping" }).catch((e: Error) => e));
    expect(err).toMatch(/API Scripts/);
    expect(err).toMatch(/Relay script loaded/);
    expect(err).toContain(getActiveCampaign().roll20CampaignId); // names the campaign
    expect(err).not.toMatch(/harvest/i);
    expect(err).not.toMatch(/token/i);
  });

  it("the Mod answered with an error: passes it through with no token advice", async () => {
    rtRelayMock.mockRejectedValue(new RtRelayError("Object not found: -abc"));
    const err = String(await relayCommand({ action: "removeObject", objectId: "-abc" }).catch((e: Error) => e));
    expect(err).toMatch(/Object not found: -abc/);
    expect(err).not.toMatch(/harvest|reconnect/i);
  });
});
