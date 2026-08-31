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
    rtRelayMock.mockRejectedValue(new Error("socket down"));
    await expect(relayCommand({ action: "getTokens" }))
      .rejects.toThrow(/does not fall back to a browser|reconnect roll20/i);
    expect(getPageMock).not.toHaveBeenCalled();
    expect(newPageMock).not.toHaveBeenCalled();
  });
});
