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
  variants: Variant[];
  note: string;
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
  pageId = emu.createPage();
  emu.setPlayerPage(pageId);
});

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

  it("refuses an unknown page rather than drawing into the void", () => {
    expect(() => emu.relay({ action: "pathv2ZoneProbe", pageId: "-NnoSuchPage" })).toThrow(/Page not found/);
  });
});
