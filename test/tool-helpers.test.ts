// Pure-logic unit tests for the tool layer (red-team #5). Most of src/tools/ is
// browser-bound integration that can't be unit-tested, but two exported helpers are
// pure AND high-value: the DL-wall geometry pipeline and the asset-path confinement
// guard (the path-traversal boundary from security.md §5).
import { describe, it, expect } from "vitest";
import { processWalls } from "../src/tools/vision.js";
import { resolveConfinedImage } from "../src/tools/maps.js";

type Pt = [number, number];
const wall = (from: Pt, to: Pt) => ({ from, to });

describe("processWalls — DL wall geometry", () => {
  it("splits a long run into contiguous max-length segments", () => {
    const out = processWalls([wall([0, 0], [300, 0])], {
      endpointInsetPx: 0, cornerOverlapPx: 0, cornerThresholdPx: 5, maxSegmentPx: 100,
    });
    expect(out).toHaveLength(3); // 300 / 100
    expect(out[0].from[0]).toBeCloseTo(0, 5);
    expect(out[2].to[0]).toBeCloseTo(300, 5);
    // contiguous: each segment's end meets the next's start
    expect(out[0].to[0]).toBeCloseTo(out[1].from[0], 5);
  });

  it("extends shared corners (overlap) but insets free ends", () => {
    // L-shape: A and B share the point (100,0).
    const [a, b] = processWalls([wall([0, 0], [100, 0]), wall([100, 0], [100, 100])], {
      endpointInsetPx: 2, cornerOverlapPx: 3, cornerThresholdPx: 5, maxSegmentPx: 1000,
    });
    // A.from is a free end → inset inward (+2 along +x); A.to is the corner → extended (+3 past it).
    expect(a.from[0]).toBeCloseTo(2, 5);
    expect(a.to[0]).toBeCloseTo(103, 5);
    // B.from is the corner → extended back past it (−3 along +y); B.to is a free end → inset (−2).
    expect(b.from[1]).toBeCloseTo(-3, 5);
    expect(b.to[1]).toBeCloseTo(98, 5);
  });

  it("leaves a short standalone wall a single segment", () => {
    const out = processWalls([wall([0, 0], [50, 0])], {
      endpointInsetPx: 0, cornerOverlapPx: 0, cornerThresholdPx: 5, maxSegmentPx: 100,
    });
    expect(out).toHaveLength(1);
  });
});

describe("resolveConfinedImage — asset-path confinement (security boundary)", () => {
  it("rejects a parent-traversal path", () => {
    expect(() => resolveConfinedImage("../../../etc/passwd")).toThrow(/escapes the asset directory/i);
  });

  it("rejects an escaping path even with a valid image extension", () => {
    expect(() => resolveConfinedImage("../secret.png")).toThrow(/escapes the asset directory/i);
  });

  it("rejects an absolute path outside the asset dir", () => {
    const abs = process.platform === "win32" ? "C:\\Windows\\system32\\drivers\\etc\\hosts" : "/etc/passwd";
    expect(() => resolveConfinedImage(abs)).toThrow(/escapes the asset directory/i);
  });

  it("rejects a non-image extension inside the asset dir", () => {
    expect(() => resolveConfinedImage("notes.txt")).toThrow(/unsupported image type/i);
  });

  it("reports a clean not-found for a valid-but-missing image", () => {
    expect(() => resolveConfinedImage("does-not-exist.png")).toThrow(/file not found/i);
  });
});
