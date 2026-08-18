// ─────────────────────────────────────────────────────────────────────────────
// create_zone targeting (issue #161).
//
// Before this fix, create_zone defaulted an unresolved center to page origin
// (0,0) and reported ok:true — a zone with no center silently landed in the
// corner of the map. This suite locks in the fix:
//   - no center given (no atPing/centerTokenId/centerX+Y)  -> throws, doesn't
//     default to (0,0)
//   - the thrown message enumerates the valid targeting modes, mirroring
//     resolve_aoe's self-correcting error wording
//   - atPing resolves a map ping to a center (mirrors resolve_aoe's atPing)
//   - atPing with no recent ping throws the same wording resolve_aoe uses
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock factories are hoisted above imports — the mock fn must be created via
// vi.hoisted so it exists before the mock factory runs.
const { getLastPingMock } = vi.hoisted(() => ({ getLastPingMock: vi.fn() }));

vi.mock("../src/bridge/roll20-rt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bridge/roll20-rt.js")>();
  return { ...actual, getLastPing: getLastPingMock };
});

import { setupHarness, type Harness } from "./harness.js";

let h: Harness;
let pageId: string;

beforeEach(() => {
  getLastPingMock.mockReset();
  getLastPingMock.mockReturnValue(null);
  h = setupHarness({ seed: 7 });
  pageId = h.emu.createPage("Zone Targeting Test Map");
  h.emu.setPlayerPage(pageId);
});

afterEach(() => {
  h.teardown();
});

describe("create_zone targeting (#161)", () => {
  it("throws instead of defaulting to (0,0) when no center is given", async () => {
    await expect(
      h.callTool("create_zone", { name: "Grasping Vine", radiusFeet: 30, pageId })
    ).rejects.toThrow();
  });

  it("the no-center error names the valid targeting modes so a model can self-correct", async () => {
    await expect(
      h.callTool("create_zone", { name: "Grasping Vine", radiusFeet: 30, pageId })
    ).rejects.toThrow(/atPing.*centerTokenId.*centerX.*centerY/s);
  });

  it("still places explicit centerX/centerY correctly (no regression)", async () => {
    const created = await h.callTool("create_zone", {
      name: "Explicit Spot", centerX: 350, centerY: 210, radiusFeet: 15, pageId,
    });
    const data = created.json as { centerX: number; centerY: number };
    expect(data.centerX).toBe(350);
    expect(data.centerY).toBe(210);
  });

  it("atPing resolves the last map ping to a center", async () => {
    getLastPingMock.mockReturnValue({
      x: 420, y: 280, rawY: -280, pageId, player: "gm-1", ts: Date.now(), focus: true,
    });

    const created = await h.callTool("create_zone", {
      name: "Grasping Vine", atPing: true, radiusFeet: 30,
    });
    const data = created.json as { centerX: number; centerY: number };
    expect(data.centerX).toBe(420);
    expect(data.centerY).toBe(280);
    expect(getLastPingMock).toHaveBeenCalled();
  });

  it("atPing with no recent ping throws the shift+click guidance", async () => {
    getLastPingMock.mockReturnValue(null);
    await expect(
      h.callTool("create_zone", { name: "Grasping Vine", atPing: true, radiusFeet: 30, pageId })
    ).rejects.toThrow(/No recent map ping seen\. Shift\+click the spot in Roll20/);
  });

  it("atPing falls back to the active page when the ping carries no pageId", async () => {
    getLastPingMock.mockReturnValue({
      x: 100, y: 150, rawY: -150, pageId: "", player: "gm-1", ts: Date.now(), focus: true,
    });

    const created = await h.callTool("create_zone", {
      name: "Grasping Vine", atPing: true, radiusFeet: 30, pageId,
    });
    const listed = await h.callTool("list_zones", { pageId });
    const zones = listed.json as Array<{ name: string }>;
    expect(zones.some((z) => z.name.includes("Grasping Vine"))).toBe(true);
    const data = created.json as { centerX: number; centerY: number };
    expect(data.centerX).toBe(100);
    expect(data.centerY).toBe(150);
  });
});
