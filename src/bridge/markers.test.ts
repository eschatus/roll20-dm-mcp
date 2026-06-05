import { describe, it, expect } from "vitest";
import { resolveMarkerForState, CONDITION_MARKERS, PSEUDO_MARKERS } from "./markers.js";

describe("resolveMarkerForState", () => {
  it("maps true 5e conditions to the condition tier", () => {
    expect(resolveMarkerForState("poisoned")).toEqual({ tag: "Poisoned::4444329", tier: "condition", key: "poisoned" });
    expect(resolveMarkerForState("dead")).toEqual({ tag: "Unconscious::4444317", tier: "condition", key: "dead" });
  });

  it("maps pseudo-conditions to the pseudo tier", () => {
    expect(resolveMarkerForState("concentrating")).toEqual({ tag: "Concentrating::4444313", tier: "pseudo", key: "concentrating" });
    expect(resolveMarkerForState("bless")).toEqual({ tag: "Blessed::4444338", tier: "pseudo", key: "bless" });
  });

  it("hashes unknown states to the custom tier", () => {
    const r = resolveMarkerForState("hexed");
    expect(r.tier).toBe("custom");
    expect(r.key).toBe("hexed");
    expect(typeof r.tag).toBe("string");
    expect(r.tag.length).toBeGreaterThan(0);
  });

  it("is case- and whitespace-insensitive (lowercased, trimmed key)", () => {
    expect(resolveMarkerForState("  POISONED ")).toEqual(resolveMarkerForState("poisoned"));
    expect(resolveMarkerForState("Hexed")).toEqual(resolveMarkerForState("hexed"));
  });

  it("hashes deterministically: same custom name → same tag every time", () => {
    const a = resolveMarkerForState("doom-marked");
    const b = resolveMarkerForState("doom-marked");
    expect(a.tag).toBe(b.tag);
  });

  it("condition tier takes precedence over pseudo/custom", () => {
    // every CONDITION_MARKERS key resolves to the condition tier
    for (const key of Object.keys(CONDITION_MARKERS)) {
      expect(resolveMarkerForState(key).tier).toBe("condition");
    }
  });

  it("pseudo keys resolve to the pseudo tier (not custom)", () => {
    for (const key of Object.keys(PSEUDO_MARKERS)) {
      // skip any pseudo key that's also a real condition (none today, but be safe)
      if (key in CONDITION_MARKERS) continue;
      expect(resolveMarkerForState(key).tier).toBe("pseudo");
    }
  });
});
