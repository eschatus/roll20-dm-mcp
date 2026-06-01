import { describe, it, expect } from "vitest";
import {
  resolveMonsterStats,
  resolveTier,
  awarenessRadius,
  rangeBand,
  MODELS,
  type StatResolutionInputs,
} from "./tactics.js";

// ─── resolveMonsterStats — the extracted pure 4-tier cascade ───────────────────

describe("resolveMonsterStats", () => {
  it("returns hard defaults (phys/CHA=10, INT/WIS=8) when no source has data", () => {
    const r = resolveMonsterStats({});
    expect(r).toEqual({
      strength: 10,
      dexterity: 10,
      constitution: 10,
      intelligence: 8,
      wisdom: 8,
      charisma: 10,
      abilitySummary: "",
    });
  });

  it("returns an immutable (frozen) object", () => {
    const r = resolveMonsterStats({});
    expect(Object.isFrozen(r)).toBe(true);
    expect(() => {
      (r as { strength: number }).strength = 99;
    }).toThrow();
  });

  it("uses character-sheet scores when present", () => {
    const sheet: StatResolutionInputs["sheet"] = {
      strength: 16,
      dexterity: 12,
      constitution: 14,
      intelligence: 6,
      wisdom: 11,
      charisma: 7,
      abilitySummary: "Actions:\n  Bite: 1d6",
    };
    const r = resolveMonsterStats({ sheet });
    expect(r.strength).toBe(16);
    expect(r.dexterity).toBe(12);
    expect(r.constitution).toBe(14);
    expect(r.intelligence).toBe(6);
    expect(r.wisdom).toBe(11);
    expect(r.charisma).toBe(7);
    expect(r.abilitySummary).toBe("Actions:\n  Bite: 1d6");
  });

  it("when the sheet has actions, DDB is NOT consulted even if sheet scores are 0", () => {
    const sheet: StatResolutionInputs["sheet"] = {
      strength: 0, // missing on sheet
      dexterity: 0,
      constitution: 0,
      intelligence: 0,
      wisdom: 0,
      charisma: 0,
      abilitySummary: "Actions:\n  Slam",
    };
    const ddb = {
      strength: 20,
      dexterity: 20,
      constitution: 20,
      intelligence: 20,
      wisdom: 20,
      charisma: 20,
      abilitySummary: "DDB summary",
    };
    const r = resolveMonsterStats({ sheet, ddb });
    // sheet had actions → DDB skipped → zeros fall through to defaults
    expect(r.strength).toBe(10);
    expect(r.intelligence).toBe(8);
    // abilitySummary stays the sheet's, not DDB's
    expect(r.abilitySummary).toBe("Actions:\n  Slam");
  });

  it("falls back to DDB scores only for missing (zero) sheet fields when sheet has NO actions", () => {
    const sheet: StatResolutionInputs["sheet"] = {
      strength: 18, // present on sheet — keep
      dexterity: 0, // missing — take from DDB
      constitution: 0,
      intelligence: 0,
      wisdom: 0,
      charisma: 0,
      abilitySummary: "", // no actions → DDB allowed
    };
    const ddb = {
      strength: 8,
      dexterity: 14,
      constitution: 13,
      intelligence: 10,
      wisdom: 9,
      charisma: 12,
      abilitySummary: "DDB summary",
    };
    const r = resolveMonsterStats({ sheet, ddb });
    expect(r.strength).toBe(18); // sheet wins
    expect(r.dexterity).toBe(14); // DDB fills gap
    expect(r.constitution).toBe(13);
    expect(r.intelligence).toBe(10);
    expect(r.wisdom).toBe(9);
    expect(r.charisma).toBe(12);
    expect(r.abilitySummary).toBe("DDB summary");
  });

  it("uses DDB entirely when there is no sheet", () => {
    const ddb = {
      strength: 7,
      dexterity: 15,
      constitution: 11,
      intelligence: 2,
      wisdom: 12,
      charisma: 6,
      abilitySummary: "Pack Tactics",
    };
    const r = resolveMonsterStats({ ddb });
    expect(r).toEqual({ ...ddb });
  });

  it("Int/Wis overrides win over both sheet and DDB", () => {
    const sheet: StatResolutionInputs["sheet"] = {
      intelligence: 6,
      wisdom: 6,
      abilitySummary: "",
    };
    const ddb = {
      strength: 10,
      dexterity: 10,
      constitution: 10,
      intelligence: 20,
      wisdom: 20,
      charisma: 10,
      abilitySummary: "x",
    };
    const r = resolveMonsterStats({ intOverride: 17, wisOverride: 13, sheet, ddb });
    expect(r.intelligence).toBe(17);
    expect(r.wisdom).toBe(13);
  });

  it("an override of 0-equivalent is respected and not overwritten by DDB", () => {
    // override is intentionally low; DDB should not bump it
    const ddb = {
      strength: 10,
      dexterity: 10,
      constitution: 10,
      intelligence: 18,
      wisdom: 18,
      charisma: 10,
      abilitySummary: "x",
    };
    const r = resolveMonsterStats({ intOverride: 3, wisOverride: 3, ddb });
    expect(r.intelligence).toBe(3);
    expect(r.wisdom).toBe(3);
  });
});

// ─── resolveTier ───────────────────────────────────────────────────────────────

describe("resolveTier", () => {
  const tierOf = (i: number, w: number) => resolveTier(i, w).tier;

  it("maps the effective (int+wis)/2 average onto the right tier band", () => {
    expect(tierOf(2, 2)).toBe(0); // avg 2  → Feral
    expect(tierOf(6, 6)).toBe(1); // avg 6  → Dim
    expect(tierOf(10, 10)).toBe(2); // avg 10 → Average
    expect(tierOf(14, 14)).toBe(3); // avg 14 → Sharp
    expect(tierOf(18, 18)).toBe(4); // avg 18 → Brilliant
    expect(tierOf(24, 24)).toBe(5); // avg 24 → Mastermind
  });

  it("uses the floored average of the two scores", () => {
    // (5+6)/2 = 5.5 → floor 5 → tier 0 (≤5)
    expect(tierOf(5, 6)).toBe(0);
    // (5+8)/2 = 6.5 → floor 6 → tier 1
    expect(tierOf(5, 8)).toBe(1);
  });

  it("each tier references a centralized MODELS id", () => {
    const ids = new Set(Object.values(MODELS));
    for (let i = 0; i <= 30; i += 2) {
      expect(ids.has(resolveTier(i, i).model as (typeof MODELS)[keyof typeof MODELS])).toBe(true);
    }
  });
});

// ─── awarenessRadius ─────────────────────────────────────────────────────────

describe("awarenessRadius", () => {
  it("never returns less than 15ft", () => {
    expect(awarenessRadius(1, 5)).toBe(15);
    expect(awarenessRadius(10, 0)).toBe(15);
  });

  it("caps at the requested radius", () => {
    // Wis 10 → computed = 60; requesting 30 should clamp to 30
    expect(awarenessRadius(10, 30)).toBe(30);
  });

  it("scales the computed ceiling with Wisdom modifier", () => {
    // Wis 10 → mod 0 → 60; request 1000 → returns 60
    expect(awarenessRadius(10, 1000)).toBe(60);
    // Wis 20 → mod +5 → 60 + 75 = 135
    expect(awarenessRadius(20, 1000)).toBe(135);
    // Wis 6 → mod -2 → 60 - 30 = 30
    expect(awarenessRadius(6, 1000)).toBe(30);
  });
});

// ─── rangeBand ───────────────────────────────────────────────────────────────

describe("rangeBand", () => {
  it("labels distance bands by feet thresholds", () => {
    expect(rangeBand(5)).toContain("adjacent");
    expect(rangeBand(20)).toContain("near");
    expect(rangeBand(45)).toContain("mid");
    expect(rangeBand(90)).toContain("far");
    expect(rangeBand(200)).toContain("distant");
  });

  it("rounds the embedded foot value", () => {
    expect(rangeBand(4.6)).toBe("adjacent (5ft)");
  });
});

