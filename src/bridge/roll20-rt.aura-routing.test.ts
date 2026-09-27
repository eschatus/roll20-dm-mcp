// ─────────────────────────────────────────────────────────────────────────────
// #210 — an aura-radius setTokenProps must reach the Mod, never the direct RTDB write path.
// The Mod owns the concentration-aura slot registry and releases/resets a claim when a ring is
// overwritten by hand; a direct write would change the ring behind the registry's back. The
// emulator harness bypasses tryDirectWrite entirely, so this is the only test that runs it.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  __tryDirectWriteForTest as tryDirectWrite,
  __NOT_HANDLED_FOR_TEST as NOT_HANDLED,
  tokenPropsNeedMod,
} from "./roll20-rt.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.RT_DEBUG;
});

describe("setTokenProps aura routing (#210)", () => {
  it("classifies aura radius writes (either slot, alone or mixed) as Mod-only", () => {
    expect(tokenPropsNeedMod({ aura2_radius: 5 })).toBe(true);
    expect(tokenPropsNeedMod({ aura1_radius: 0 })).toBe(true);
    expect(tokenPropsNeedMod({ tint_color: "#ff0000", aura1_radius: 15 })).toBe(true);
    expect(tokenPropsNeedMod({ tint_color: "#ff0000", aura1_color: "#00ff00" })).toBe(false);
  });

  it("does NOT handle setTokenProps {aura2_radius:5} directly — and never even looks the token up", async () => {
    // With RT_DEBUG on, a direct attempt that fails (no RTDB connection in a test) logs
    // "direct write setTokenProps failed → Mod fallback". The routing guard must return before
    // any such attempt, so NOT_HANDLED here is the guard, not the catch-all swallowing an error.
    process.env.RT_DEBUG = "1";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await tryDirectWrite({ action: "setTokenProps", tokenId: "tok-1", pageId: "page-1", props: { aura2_radius: 5 } });
    expect(res).toBe(NOT_HANDLED);
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/direct write setTokenProps failed/);
  });
});
