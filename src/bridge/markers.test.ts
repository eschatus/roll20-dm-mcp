import { describe, it, expect } from "vitest";
import {
  resolveMarkerForState, CONDITION_MARKERS, PSEUDO_MARKERS,
  computeHpThresholds, WOUNDED_MARKER, DEAD_MARKER,
} from "./markers.js";

describe("resolveMarkerForState", () => {
  it("maps true 5e conditions to the condition tier", () => {
    expect(resolveMarkerForState("poisoned")).toEqual({ tag: "Poisoned::4444329", tier: "condition", key: "poisoned" });
    // "dead" is Roll20's BUILT-IN red-X overlay, present in every campaign. It used
    // to alias the custom Unconscious marker, which renders as nothing wherever the
    // custom marker set isn't installed (observed live: dead tokens at 0 HP on the
    // map layer carrying an invisible marker). Unconscious stays for unconscious.
    expect(resolveMarkerForState("dead")).toEqual({ tag: "dead", tier: "condition", key: "dead" });
    expect(resolveMarkerForState("unconscious")).toEqual({ tag: "Unconscious::4444317", tier: "condition", key: "unconscious" });
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

// Issue #141: bloodied/wounded threshold automation moved server-side, applied
// after any NPC/sidekick bar1 write. Pure arithmetic — unit-tested here; the
// same rule is hand-synced into mod-scripts/ai-relay.js (ACTIONS["setTokenBar"] +
// runBatchOp) and mirrored (via direct import of this module, not a copy) in
// src/bridge/roll20-rt.ts's tryDirectWrite "setTokenBar" case.
describe("computeHpThresholds", () => {
  it("full HP: neither wounded nor dead", () => {
    expect(computeHpThresholds(33, 33)).toEqual({ wounded: false, dead: false });
  });

  it("crossing down to at-or-below half applies wounded (SYMMETRIC threshold)", () => {
    expect(computeHpThresholds(16, 33)).toEqual({ wounded: true, dead: false }); // 32 <= 33
    expect(computeHpThresholds(17, 33)).toEqual({ wounded: false, dead: false }); // 34 > 33
  });

  it("exact half boundary: current*2 <= max means AT half IS wounded", () => {
    expect(computeHpThresholds(15, 30)).toEqual({ wounded: true, dead: false }); // 30 <= 30 — boundary
    expect(computeHpThresholds(16, 30)).toEqual({ wounded: false, dead: false }); // 32 > 30 — just above
  });

  it("healing back above half REMOVES wounded (symmetric, not narration-driven)", () => {
    expect(computeHpThresholds(5, 33)).toEqual({ wounded: true, dead: false });
    expect(computeHpThresholds(20, 33)).toEqual({ wounded: false, dead: false });
  });

  it("auto-dead at 0 (or below, from overkill damage), not wounded", () => {
    expect(computeHpThresholds(0, 33)).toEqual({ wounded: false, dead: true });
    expect(computeHpThresholds(-5, 33)).toEqual({ wounded: false, dead: true });
  });

  it("a barless token (max<=0) is never automated", () => {
    expect(computeHpThresholds(0, 0)).toEqual({ wounded: false, dead: false });
    expect(computeHpThresholds(5, 0)).toEqual({ wounded: false, dead: false });
  });

  it("WOUNDED_MARKER / DEAD_MARKER alias the canonical pseudo/condition tags", () => {
    expect(WOUNDED_MARKER).toBe(PSEUDO_MARKERS.wounded);
    expect(DEAD_MARKER).toBe(CONDITION_MARKERS.dead);
  });
});
