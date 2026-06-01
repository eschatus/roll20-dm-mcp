import { describe, it, expect } from "vitest";
import { parseStats, getMaxHp, getCurrentHp, type DdbCharacter } from "./dndbeyond.js";

// Minimal DdbCharacter factory — only the fields getMaxHp/getCurrentHp read.
function makeChar(overrides: Partial<DdbCharacter> = {}): DdbCharacter {
  return {
    id: 1,
    name: "Test",
    baseHitPoints: 0,
    bonusHitPoints: null,
    overrideHitPoints: null,
    removedHitPoints: 0,
    temporaryHitPoints: 0,
    conditions: [],
    avatarUrl: null,
    armorClass: 10,
    passivePerception: 10,
    classes: [],
    stats: [],
    ...overrides,
  };
}

describe("getMaxHp", () => {
  it("adds Constitution modifier per total level to base hit points", () => {
    // Level 5, CON 14 (+2) → 30 base + 2*5 = 40
    const char = makeChar({
      baseHitPoints: 30,
      classes: [{ level: 5 }],
      stats: [{ id: 3, value: 14 }],
    });
    expect(getMaxHp(char)).toBe(40);
  });

  it("sums multiclass levels for the Con contribution", () => {
    // Levels 3 + 2 = 5, CON 16 (+3) → 28 + 3*5 = 43
    const char = makeChar({
      baseHitPoints: 28,
      classes: [{ level: 3 }, { level: 2 }],
      stats: [{ id: 3, value: 16 }],
    });
    expect(getMaxHp(char)).toBe(43);
  });

  it("includes bonusHitPoints when present", () => {
    // 20 base + 5 bonus + (CON 12 → +1) * 4 levels = 29
    const char = makeChar({
      baseHitPoints: 20,
      bonusHitPoints: 5,
      classes: [{ level: 4 }],
      stats: [{ id: 3, value: 12 }],
    });
    expect(getMaxHp(char)).toBe(29);
  });

  it("treats a missing Constitution stat as score 10 (+0 modifier)", () => {
    const char = makeChar({ baseHitPoints: 25, classes: [{ level: 3 }], stats: [] });
    expect(getMaxHp(char)).toBe(25);
  });

  it("applies a negative Con modifier", () => {
    // CON 8 (-1) over 4 levels → 30 - 4 = 26
    const char = makeChar({
      baseHitPoints: 30,
      classes: [{ level: 4 }],
      stats: [{ id: 3, value: 8 }],
    });
    expect(getMaxHp(char)).toBe(26);
  });

  it("uses overrideHitPoints verbatim, ignoring base + Con math", () => {
    const char = makeChar({
      baseHitPoints: 30,
      overrideHitPoints: 99,
      classes: [{ level: 5 }],
      stats: [{ id: 3, value: 18 }],
    });
    expect(getMaxHp(char)).toBe(99);
  });
});

describe("getCurrentHp", () => {
  it("subtracts removedHitPoints from max", () => {
    const char = makeChar({
      baseHitPoints: 30,
      classes: [{ level: 5 }],
      stats: [{ id: 3, value: 14 }],
      removedHitPoints: 13,
    });
    // max 40 - 13 = 27
    expect(getCurrentHp(char)).toBe(27);
  });

  it("equals max when nothing has been removed", () => {
    const char = makeChar({
      baseHitPoints: 20,
      classes: [{ level: 2 }],
      stats: [{ id: 3, value: 10 }],
    });
    expect(getCurrentHp(char)).toBe(getMaxHp(char));
  });
});

describe("parseStats", () => {
  // A representative raw character-service payload (only fields parseStats reads).
  function makeRaw() {
    return {
      name: "Aria",
      classes: [{ level: 5, definition: { name: "Wizard" } }],
      stats: [
        { id: 1, value: 8 },   // STR
        { id: 2, value: 14 },  // DEX → +2
        { id: 3, value: 12 },  // CON → +1
        { id: 4, value: 18 },  // INT → +4
        { id: 5, value: 13 },  // WIS → +1
        { id: 6, value: 10 },  // CHA
      ],
      overrideStats: [],
      modifiers: {
        race: [],
        class: [
          { type: "proficiency", subType: "intelligence-saving-throws", value: null },
          { type: "proficiency", subType: "wisdom-saving-throws", value: null },
          { type: "proficiency", subType: "arcana", value: null },
          { type: "expertise", subType: "investigation", value: null },
        ],
        background: [],
        item: [],
        feat: [],
        condition: [],
      },
      baseHitPoints: 25,
      bonusHitPoints: null,
      overrideHitPoints: null,
      removedHitPoints: 8,
      temporaryHitPoints: 4,
      armorClass: 12,
      race: { weightSpeeds: { normal: { walk: 30 } } },
      conditions: [{ id: 11 }], // poisoned
    };
  }

  it("computes level, proficiency bonus, and class string", () => {
    const s = parseStats(makeRaw());
    expect(s.level).toBe(5);
    expect(s.proficiencyBonus).toBe(3); // level 5 → PB +3
    expect(s.classes).toBe("Wizard5");
  });

  it("derives ability modifiers from final scores", () => {
    const s = parseStats(makeRaw());
    expect(s.abilityMods.intelligence).toBe(4);
    expect(s.abilityMods.dexterity).toBe(2);
    expect(s.abilityMods.strength).toBe(-1);
  });

  it("marks proficient saves and adds the proficiency bonus", () => {
    const s = parseStats(makeRaw());
    expect(s.savingThrows.intelligence.proficient).toBe(true);
    expect(s.savingThrows.intelligence.bonus).toBe(4 + 3); // INT mod + PB
    expect(s.savingThrows.strength.proficient).toBe(false);
    expect(s.savingThrows.strength.bonus).toBe(-1);
  });

  it("applies proficiency and expertise to skills", () => {
    const s = parseStats(makeRaw());
    // arcana: INT(+4) + PB(3) proficient
    expect(s.skills.arcana.proficient).toBe(true);
    expect(s.skills.arcana.bonus).toBe(4 + 3);
    // investigation: INT(+4) + 2*PB expertise
    expect(s.skills.investigation.expertise).toBe(true);
    expect(s.skills.investigation.bonus).toBe(4 + 3 * 2);
  });

  it("computes HP from base + Con*level minus removed, plus temp and AC", () => {
    const s = parseStats(makeRaw());
    // max = 25 + CON(+1)*5 = 30; current = 30 - 8 = 22
    expect(s.hp.max).toBe(30);
    expect(s.hp.current).toBe(22);
    expect(s.hp.temp).toBe(4);
    expect(s.armorClass).toBe(12);
  });

  it("computes passive perception and initiative from modifiers", () => {
    const s = parseStats(makeRaw());
    // perception not proficient → 10 + WIS(+1) = 11
    expect(s.passivePerception).toBe(11);
    // initiative = DEX mod with no bonus modifiers
    expect(s.initiativeBonus).toBe(2);
    expect(s.walkSpeed).toBe(30);
  });

  it("maps active condition ids to lowercased names", () => {
    const s = parseStats(makeRaw());
    expect(s.conditions).toEqual(["poisoned"]);
  });

  it("honors an ability-score override", () => {
    const raw = makeRaw();
    raw.overrideStats = [{ id: 4, value: 20 }] as never; // INT override → 20 (+5)
    const s = parseStats(raw);
    expect(s.abilityScores.intelligence).toBe(20);
    expect(s.abilityMods.intelligence).toBe(5);
  });
});
