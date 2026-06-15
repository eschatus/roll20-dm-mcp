import { describe, it, expect } from "vitest";
import {
  saveAttrNames,
  resolveSaveBonus,
  damageOnSave,
  isPcToken,
  splitPcNpc,
  isDowned,
  resolveNamesToTokens,
  type AoeToken,
} from "./aoe.js";

describe("saveAttrNames", () => {
  it("orders NPC save bonus before PC bonus before raw scores", () => {
    expect(saveAttrNames("dexterity")).toEqual([
      "npc_dex_save", "dexterity_save_bonus", "npc_dexterity", "dexterity",
    ]);
  });
});

describe("resolveSaveBonus", () => {
  const attrs = (m: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { current: v }]));

  it("uses npc save bonus directly when present", () => {
    expect(resolveSaveBonus(attrs({ npc_dex_save: "5", npc_dexterity: 18 }), "dexterity"))
      .toEqual({ bonus: 5, source: "npc_dex_save" });
  });

  it("skips empty-string attrs and falls through the cascade", () => {
    expect(resolveSaveBonus(attrs({ npc_dex_save: "", npc_dexterity: "14" }), "dexterity"))
      .toEqual({ bonus: 2, source: "npc_dexterity" });
  });

  it("converts ability scores to modifiers (floor)", () => {
    expect(resolveSaveBonus(attrs({ wisdom: 9 }), "wisdom")).toEqual({ bonus: -1, source: "wisdom" });
    expect(resolveSaveBonus(attrs({ strength: 20 }), "strength")).toEqual({ bonus: 5, source: "strength" });
  });

  it("defaults to +0 flat d20 with nothing usable", () => {
    expect(resolveSaveBonus(null, "constitution")).toEqual({ bonus: 0, source: "none" });
    expect(resolveSaveBonus(attrs({ npc_con_save: "abc" }), "constitution")).toEqual({ bonus: 0, source: "none" });
  });
});

describe("damageOnSave", () => {
  it("fail takes full, save takes floored half by default", () => {
    expect(damageOnSave(false, 27, true)).toBe(27);
    expect(damageOnSave(true, 27, true)).toBe(13);
  });
  it("save negates when halfOnSave=false", () => {
    expect(damageOnSave(true, 27, false)).toBe(0);
    expect(damageOnSave(false, 27, false)).toBe(27);
  });
});

describe("isPcToken / splitPcNpc", () => {
  const tok = (controlledby?: string): AoeToken => ({ id: "x", name: "X", controlledby });

  it("treats real player ids as PCs, 'all' and empty as NPC/scenery", () => {
    expect(isPcToken(tok("-PL1"))).toBe(true);
    expect(isPcToken(tok("-PL1,all"))).toBe(true);
    expect(isPcToken(tok("all"))).toBe(false);
    expect(isPcToken(tok(""))).toBe(false);
    expect(isPcToken(tok(undefined))).toBe(false);
  });

  it("splits a mixed group", () => {
    const list = [
      { id: "a", name: "Winsome", controlledby: "-PL1" },
      { id: "b", name: "Zombie", controlledby: "" },
      { id: "c", name: "Door", controlledby: "all" },
    ];
    const { pcs, npcs } = splitPcNpc(list);
    expect(pcs.map((t) => t.name)).toEqual(["Winsome"]);
    expect(npcs.map((t) => t.name)).toEqual(["Zombie", "Door"]);
  });
});

describe("isDowned", () => {
  it("0 HP with a real max is down; barless tokens are not", () => {
    expect(isDowned({ id: "a", name: "Z", bar1_value: 0, bar1_max: 22 })).toBe(true);
    expect(isDowned({ id: "b", name: "Z", bar1_value: 5, bar1_max: 22 })).toBe(false);
    expect(isDowned({ id: "c", name: "Door", bar1_value: 0, bar1_max: 0 })).toBe(false);
    expect(isDowned({ id: "d", name: "Statue" })).toBe(false);
  });
});

describe("resolveNamesToTokens", () => {
  const tokens: AoeToken[] = [
    { id: "1", name: "Zombie 1" },
    { id: "2", name: "Zombie 12" },
    { id: "3", name: "Flameskull the Gaunt" },
  ];

  it("prefers exact match over substring (Zombie 1 ≠ Zombie 12)", () => {
    const { matched } = resolveNamesToTokens(["zombie 1"], tokens);
    expect(matched.map((t) => t.id)).toEqual(["1"]);
  });

  it("falls back to substring and reports misses, deduping hits", () => {
    const { matched, missed } = resolveNamesToTokens(["flameskull", "Flameskull the Gaunt", "ghost"], tokens);
    expect(matched.map((t) => t.id)).toEqual(["3"]);
    expect(missed).toEqual(["ghost"]);
  });
});
