// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS["pathv2ZoneProbe"] — the issue #208 spike instrument.
//
// The probe exists to answer three questions that only a LIVE Roll20 sandbox can
// answer (does `fill` honour #RRGGBBAA, does shape "eli"/"rec" render off the walls
// layer, does pathv2 carry name/gmnotes). The emulator cannot answer any of them —
// it is permissive where the real sandbox silently drops writes, which is the whole
// reason #162/#164 shipped. So this file pins the part that IS checkable offline:
// the probe builds the right variants, with the right geometry, and reports what it
// sent alongside what came back. A geometry bug here would make a live run lie.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from "vitest";
import { Roll20Emulator } from "./roll20-emulator.js";

interface Variant {
  key: string;
  shape: string;
  layer: string;
  sentFill: string;
  sentFillOpacity?: number;
  id?: string;
  centerX: number;
  centerY: number;
  anchorX: number;
  anchorY: number;
  pointCount: number;
  offPage: boolean;
  created: boolean;
  error?: string;
  stored: Record<string, unknown>;
  missing: string[];
  wrote?: { atCreate: { name: string; gmnotes: string }; afterSet: { name: string; gmnotes: string } };
  storedAfterSet?: { name?: unknown; gmnotes?: unknown };
}
interface ProbeResult {
  pageId: string;
  hex6: string;
  hex8: string;
  radiusPx: number;
  rowY: number;
  rowYs: number[];
  pageWidthPx: number;
  pageHeightPx: number;
  variants: Variant[];
  stashedIds: string[];
  note: string;
}
interface ClearLast {
  cleared: boolean;
  stash: { pageId: string; ids: string[]; at: number } | null;
  removed: string[];
  alreadyGone: string[];
  failed: Array<{ id: string; error: string }>;
}

let emu: Roll20Emulator;
let pageId: string;
const RADIUS = 140;

function runProbe(extra: Record<string, unknown> = {}): ProbeResult {
  return emu.relay<ProbeResult>({
    action: "pathv2ZoneProbe",
    pageId,
    centerX: 500,
    centerY: 400,
    radiusPx: RADIUS,
    ...extra,
  });
}

beforeEach(() => {
  emu = new Roll20Emulator({ seed: 208 });
  emu.load();
  // Wide enough (60 units = 4200px) for all eight variants in one row at x=500.
  pageId = emu.createPage("Probe", { width: 60, height: 40 });
  emu.setPlayerPage(pageId);
});

function probeStash(): { pageId: string; ids: string[]; at: number } | undefined {
  return (emu.state.GM_AI_Bridge as { pathv2Probe?: { pageId: string; ids: string[]; at: number } } | undefined)
    ?.pathv2Probe;
}

describe("pathv2ZoneProbe — variant coverage", () => {
  it("covers all three questions, with a control for each", () => {
    const res = runProbe();
    const keys = res.variants.map(v => v.key);
    expect(keys).toEqual([
      "eli-fill8",        // Q1 candidate: 8-digit #RRGGBBAA
      "eli-fill6",        // Q1 control: opaque
      "eli-fillopacity",  // Q1 alternative: a real fill_opacity property
      "eli-transparent",  // Q2 control: outline only
      "rec-fill8",        // Q2 rectangle
      "pol-fill8",        // Q2 control: today's 36-gon
      "eli-map-layer",    // Q2 layer check
      "eli-meta",         // Q3 name/gmnotes
    ]);
    expect(res.variants.every(v => v.created)).toBe(true);
    expect(res.variants.every(v => typeof v.id === "string" && v.id.length > 0)).toBe(true);
  });

  it("is a left-to-right row at one y, so a human can compare the shapes side by side", () => {
    const res = runProbe();
    expect(res.rowY).toBe(400);
    expect(res.rowYs).toEqual([400]);
    expect(res.variants.every(v => !v.offPage)).toBe(true);
    expect(new Set(res.variants.map(v => v.centerY))).toEqual(new Set([400]));
    const xs = res.variants.map(v => v.centerX);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    // radius*2 of shape plus one 70px cell of gutter — no overlap between variants.
    expect(new Set(gaps)).toEqual(new Set([RADIUS * 2 + 70]));
  });

  it("only the fill_opacity variant sends fill_opacity", () => {
    const res = runProbe();
    const withOpacity = res.variants.filter(v => v.sentFillOpacity !== undefined);
    expect(withOpacity.map(v => v.key)).toEqual(["eli-fillopacity"]);
    expect(withOpacity[0].sentFillOpacity).toBe(0.25);
  });
});

describe("pathv2ZoneProbe — page fit (row wrap)", () => {
  it("wraps onto a new row instead of drawing past the right edge of a default-size page", () => {
    // Roll20's default page: 25 units wide/tall = 1750px (width/height are 70px UNITS).
    const small = emu.createPage("Default", { width: 25, height: 25 });
    const res = emu.relay<ProbeResult>({ action: "pathv2ZoneProbe", pageId: small });
    expect(res.pageWidthPx).toBe(1750);
    // Defaults: r=140 → shapes 280px across + 70px gutter = 350px step, first centre at 210.
    for (const v of res.variants) {
      expect(v.centerX + res.radiusPx, v.key).toBeLessThanOrEqual(1750);
      expect(v.centerX - res.radiusPx, v.key).toBeGreaterThanOrEqual(0);
      expect(v.offPage, v.key).toBe(false);
    }
    expect(res.rowYs.length).toBeGreaterThan(1);
    expect(res.rowYs).toEqual([210, 560]);
    // Every new row restarts at the left column, and rows never overlap.
    expect(new Set(res.variants.filter(v => v.centerY === 560).map(v => v.centerX)).has(210)).toBe(true);
  });

  it("wraps the 30-unit (2100px) page Devin flagged", () => {
    const p30 = emu.createPage("Thirty", { width: 30, height: 30 });
    const res = emu.relay<ProbeResult>({ action: "pathv2ZoneProbe", pageId: p30 });
    expect(res.variants.every(v => v.centerX + res.radiusPx <= 2100)).toBe(true);
    expect(res.variants.every(v => !v.offPage)).toBe(true);
  });

  it("flags a shape that still cannot fit, rather than hiding it", () => {
    const tiny = emu.createPage("Tiny", { width: 3, height: 3 });
    const res = emu.relay<ProbeResult>({ action: "pathv2ZoneProbe", pageId: tiny });
    expect(res.variants.some(v => v.offPage)).toBe(true);
  });

  it("falls back to Roll20's 25-unit default when the page size is unreadable", () => {
    const bare = emu.createPage("No size");
    const res = emu.relay<ProbeResult>({ action: "pathv2ZoneProbe", pageId: bare });
    expect(res.pageWidthPx).toBe(1750);
    expect(res.pageHeightPx).toBe(1750);
  });
});

describe("pathv2ZoneProbe — geometry", () => {
  it("anchors eli/rec at the bounding box top-left, since pathv2 re-anchors to point 0", () => {
    const res = runProbe();
    for (const v of res.variants.filter(x => x.shape === "eli" || x.shape === "rec")) {
      expect(v.anchorX, v.key).toBe(v.centerX - RADIUS);
      expect(v.anchorY, v.key).toBe(v.centerY - RADIUS);
      // First two points ARE the bounding box, relative to that anchor.
      expect(v.stored.pointsTruncated, v.key).toBe(false);
      expect(JSON.parse(String(v.stored.pointsPreview)), v.key).toEqual([[0, 0], [RADIUS * 2, RADIUS * 2]]);
      expect(v.stored.pointsBBox, v.key).toEqual({ minX: 0, minY: 0, maxX: RADIUS * 2, maxY: RADIUS * 2 });
      expect(v.stored.x, v.key).toBe(v.centerX - RADIUS);
      expect(v.stored.width, v.key).toBe(RADIUS * 2);
    }
  });

  it("anchors the polyline control at its first point, on the circle, not the centre", () => {
    const res = runProbe();
    const pol = res.variants.find(v => v.key === "pol-fill8")!;
    expect(pol.anchorX).toBe(pol.centerX + RADIUS);
    expect(pol.anchorY).toBe(pol.centerY);
    expect(pol.pointCount).toBe(37); // 36 segments, closed back onto the first point
    // Point 0 is the origin (it IS the anchor); the circle then extends one diameter
    // to the left of it and one radius up/down — the bbox proves both without shipping
    // 500 chars of point data back over RTDB.
    expect(String(pol.stored.pointsPreview).startsWith("[[0,0],")).toBe(true);
    expect(pol.stored.pointsTruncated).toBe(true);
    expect(pol.stored.pointsBBox).toEqual({ minX: -RADIUS * 2, maxX: 0, minY: -RADIUS, maxY: RADIUS });
  });
});

describe("pathv2ZoneProbe — colours", () => {
  it("derives the translucent fill from the opaque one, and defaults to the zone alpha", () => {
    const res = runProbe();
    expect(res.hex6).toBe("#aa00ff");
    expect(res.hex8).toBe("#aa00ff40"); // ZONE_FILL_ALPHA_HEX, same constant createZone bakes in
    expect(res.variants.find(v => v.key === "eli-fill8")!.sentFill).toBe("#aa00ff40");
    expect(res.variants.find(v => v.key === "eli-fill6")!.sentFill).toBe("#aa00ff");
    expect(res.variants.find(v => v.key === "eli-transparent")!.sentFill).toBe("transparent");
  });

  it("honours an explicit colour and alpha, and ignores a malformed colour", () => {
    expect(runProbe({ color: "#00aa44", alphaHex: "80" }).hex8).toBe("#00aa4480");
    // An 8-digit input keeps its RGB but takes the probe's alpha — never double-appended.
    expect(runProbe({ color: "#00aa4412" }).hex8).toBe("#00aa4440");
    expect(runProbe({ color: "not-a-colour" }).hex6).toBe("#aa00ff");
    expect(runProbe({ alphaHex: "zz" }).hex8).toBe("#aa00ff40");
  });
});

describe("pathv2ZoneProbe — metadata question (Q3)", () => {
  it("reports what it wrote, not just what came back", () => {
    const res = runProbe();
    const meta = res.variants.find(v => v.key === "eli-meta")!;
    // The caller has to compare read-back against the exact written string: a sandbox
    // that drops the write can return "" rather than undefined (#164).
    expect(meta.wrote!.atCreate.name).toBe("ZONE PROBE eli-meta");
    expect(meta.wrote!.afterSet.name).toBe("ZONE PROBE set-after");
    expect(meta.wrote!.atCreate.gmnotes).toBe("probe gmnotes at create");
    expect(meta.storedAfterSet).toBeDefined();
    // No other variant pays for the metadata write.
    expect(res.variants.filter(v => v.wrote).map(v => v.key)).toEqual(["eli-meta"]);
  });
});

describe("pathv2ZoneProbe — housekeeping", () => {
  it("creates real pathv2 objects that the documented cleanup call can remove", () => {
    const res = runProbe();
    for (const v of res.variants) {
      const r = emu.relay<{ ok: boolean; id: string }>({
        action: "removeObject",
        objectType: "pathv2",
        objectId: v.id!,
      });
      expect(r.ok, v.key).toBe(true);
    }
    // Gone: a second removal of the same id must now fail, not quietly report success.
    expect(() =>
      emu.relay({ action: "removeObject", objectType: "pathv2", objectId: res.variants[0].id! })
    ).toThrow(/not found/i);
  });

  it("stashes every created id in state BEFORE replying, so lost ids are recoverable", () => {
    const res = runProbe();
    const stash = probeStash()!;
    expect(stash.pageId).toBe(pageId);
    expect(stash.ids).toEqual(res.variants.map(v => v.id));
    expect(typeof stash.at).toBe("number");
    expect(res.stashedIds).toEqual(stash.ids);
  });

  it("accumulates across runs, so a second run never orphans the first", () => {
    const a = runProbe();
    const b = runProbe();
    expect(probeStash()!.ids).toEqual([...a.variants, ...b.variants].map(v => v.id));
  });

  it("clearLast removes every stashed shape and clears the stash", () => {
    const res = runProbe();
    const r = emu.relay<ClearLast>({ action: "pathv2ZoneProbe", clearLast: true });
    expect(r.cleared).toBe(true);
    expect(r.removed).toEqual(res.variants.map(v => v.id));
    expect(r.alreadyGone).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(probeStash()).toBeUndefined();
    for (const v of res.variants) {
      expect(() => emu.relay({ action: "removeObject", objectType: "pathv2", objectId: v.id! })).toThrow(/not found/i);
    }
  });

  it("clearLast reports ids already removed by hand as alreadyGone, not failures", () => {
    const res = runProbe();
    emu.relay({ action: "removeObject", objectType: "pathv2", objectId: res.variants[0].id! });
    const r = emu.relay<ClearLast>({ action: "pathv2ZoneProbe", clearLast: true });
    expect(r.cleared).toBe(true);
    expect(r.alreadyGone).toEqual([res.variants[0].id]);
    expect(r.removed).toHaveLength(res.variants.length - 1);
    expect(probeStash()).toBeUndefined();
  });

  it("clearLast with nothing stashed says so and needs no page", () => {
    const r = emu.relay<ClearLast>({ action: "pathv2ZoneProbe", clearLast: true });
    expect(r.cleared).toBe(false);
    expect(r.stash).toBeNull();
  });

  it("refuses an unknown page rather than drawing into the void", () => {
    expect(() => emu.relay({ action: "pathv2ZoneProbe", pageId: "-NnoSuchPage" })).toThrow(/Page not found/);
  });
});
