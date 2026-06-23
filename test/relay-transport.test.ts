// Transport-default + no-silent-fallback guard (#83/#84).
//
// The emulator harness routes through __setBridgeTestTransport, so it can't exercise the
// rtEnabled() decision or the "no browser fallback" behavior. This test mocks the RT layer and the
// browser bridge directly to assert: RT is the default, the browser relay is reachable ONLY via an
// explicit opt-out, and an RT failure surfaces an actionable error WITHOUT ever touching a browser.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock factories are hoisted above imports — define the spies via vi.hoisted so they exist first.
const { rtRelayMock, getPageMock, newPageMock } = vi.hoisted(() => ({
  rtRelayMock: vi.fn(),
  getPageMock: vi.fn(async () => { throw new Error("BROWSER PATH REACHED — must not happen under RT"); }),
  newPageMock: vi.fn(async () => { throw new Error("BROWSER PATH REACHED — must not happen under RT"); }),
}));

// Keep rtEnabled() real (it reads process.env); stub only the network call.
vi.mock("../src/bridge/roll20-rt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bridge/roll20-rt.js")>();
  return { ...actual, rtRelayCommand: rtRelayMock };
});

// Any browser access fails loudly so a hidden fallback can't pass silently.
vi.mock("../src/bridge/browser.js", () => ({
  getPage: getPageMock,
  newBrowserPage: newPageMock,
  closeBrowser: vi.fn(),
}));

import { relayCommand } from "../src/bridge/roll20.js";
import { rtEnabled } from "../src/bridge/roll20-rt.js";

describe("relay transport default — browserless RT, no silent fallback (#83/#84)", () => {
  const orig = process.env.ROLL20_TRANSPORT;
  beforeEach(() => { rtRelayMock.mockReset(); getPageMock.mockClear(); newPageMock.mockClear(); });
  afterEach(() => {
    if (orig === undefined) delete process.env.ROLL20_TRANSPORT;
    else process.env.ROLL20_TRANSPORT = orig;
  });

  it("defaults to RT (browserless) when ROLL20_TRANSPORT is unset", () => {
    delete process.env.ROLL20_TRANSPORT;
    expect(rtEnabled()).toBe(true);
  });

  it("only ROLL20_TRANSPORT=browser opts out of RT", () => {
    process.env.ROLL20_TRANSPORT = "browser";
    expect(rtEnabled()).toBe(false);
    process.env.ROLL20_TRANSPORT = "rt";
    expect(rtEnabled()).toBe(true);
    process.env.ROLL20_TRANSPORT = "BROWSER"; // case-insensitive
    expect(rtEnabled()).toBe(false);
  });

  it("routes through RT and returns its result, never opening a browser", async () => {
    delete process.env.ROLL20_TRANSPORT;
    rtRelayMock.mockResolvedValue({ ok: true });
    const res = await relayCommand({ action: "getTokens", pageId: "p1" });
    expect(res).toEqual({ ok: true });
    expect(rtRelayMock).toHaveBeenCalledTimes(1);
    expect(getPageMock).not.toHaveBeenCalled();
    expect(newPageMock).not.toHaveBeenCalled();
  });

  it("on RT failure throws an actionable error and does NOT fall back to the browser", async () => {
    delete process.env.ROLL20_TRANSPORT;
    rtRelayMock.mockRejectedValue(new Error("socket down"));
    await expect(relayCommand({ action: "getTokens" }))
      .rejects.toThrow(/does not fall back to a browser|reconnect roll20/i);
    expect(getPageMock).not.toHaveBeenCalled();
    expect(newPageMock).not.toHaveBeenCalled();
  });
});
