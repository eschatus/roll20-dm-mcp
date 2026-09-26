// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS["setAttrs"] — the sheet-aware attribute carrier (#206).
//
// SCOPE WARNING. These tests cover the relay PLUMBING only: the capability probe,
// the {current,max} → "<name>"/"<name>_max" flattening, the undefined/NaN guard,
// the silent (plain-`set`) arm, and faithful relaying of what
// onSheetWorkerCompleted reported. They deliberately do NOT — and cannot —
// establish whether a real sheet's workers fire on an API-side setAttrs, which is
// the actual question in #206: the emulator has no character sheet, so its shim
// runs no workers and always reports workersExecuted:false. That question is
// answered live by src/recon/setattrs-spike.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from "vitest";
import { Roll20Emulator } from "./roll20-emulator.js";

type SetAttrsResult = {
  charId: string;
  written: string[];
  silent: boolean;
  workersExecuted: boolean | null;
  note: string | null;
  sheet: { sandbox: string | null; sheetName: string | null; beacon: boolean };
};

function shimEmu(): Roll20Emulator {
  const emu = new Roll20Emulator({ seed: 11, sheetWriteShim: true });
  emu.load();
  return emu;
}

describe("setAttrs capability probe", () => {
  it("fails loudly, naming the sandbox version, when the sandbox has no setAttrs", () => {
    // Default emulator = no shim, which is exactly a sandbox that lacks the global.
    const emu = new Roll20Emulator({ seed: 11 });
    emu.load();
    emu.campaignModel.set("turnorder", "");
    const charId = emu.createCharacter("Probe", {});
    expect(() => emu.relay({ action: "setAttrs", charId, attributes: { strength: 14 } }))
      .toThrow(/setAttrs\(\) is not a function in this sandbox/);
  });

  it("requires charId", () => {
    const emu = shimEmu();
    expect(() => emu.relay({ action: "setAttrs", attributes: { strength: 14 } }))
      .toThrow(/charId is required/);
  });
});

describe("setAttrs write shape", () => {
  it("flattens {current, max} into setAttrs' own flat name space", () => {
    const emu = shimEmu();
    const charId = emu.createCharacter("Goblin", {});
    const res = emu.relay<SetAttrsResult>({
      action: "setAttrs",
      charId,
      attributes: { hp: { current: 7, max: 12 }, strength: 8 },
    });

    expect(emu.setAttrsCalls).toHaveLength(1);
    expect(emu.setAttrsCalls[0].charId).toBe(charId);
    expect(emu.setAttrsCalls[0].values).toEqual({ hp: 7, hp_max: 12, strength: 8 });
    expect(res.written.sort()).toEqual(["hp", "hp_max", "strength"]);
  });

  it("passes repeating-row and _max names through verbatim", () => {
    const emu = shimEmu();
    const charId = emu.createCharacter("Ogre", {});
    emu.relay({
      action: "setAttrs",
      charId,
      attributes: {
        "repeating_npcaction_$0_name": "Greatclub",
        "repeating_npcaction_$0_attack_tohit": 6,
        "npc_hpbase_max": 59,
      },
    });
    expect(Object.keys(emu.setAttrsCalls[0].values).sort()).toEqual([
      "npc_hpbase_max",
      "repeating_npcaction_$0_attack_tohit",
      "repeating_npcaction_$0_name",
    ]);
  });

  it("drops undefined/NaN before they can reach a Roll20 write", () => {
    // An undefined/NaN value async-crashes the whole sandbox (CLAUDE.md, setSafe).
    // setAttrs ends up writing attribute objects too, so it goes through the same guard.
    const emu = shimEmu();
    const charId = emu.createCharacter("Guard", {});
    const res = emu.relay<SetAttrsResult>({
      action: "setAttrs",
      charId,
      attributes: { strength: 15, dexterity: null, wisdom: { current: undefined, max: 3 } },
    });
    expect(emu.setAttrsCalls[0].values).toEqual({ strength: 15, wisdom_max: 3 });
    expect(res.written.sort()).toEqual(["strength", "wisdom_max"]);
  });

  it("actually lands the values where a readback can see them", () => {
    const emu = shimEmu();
    const charId = emu.createCharacter("Scout", {});
    emu.relay({ action: "setAttrs", charId, attributes: { dexterity: 16 } });
    const attrs = emu.relay<Record<string, unknown>>({ action: "getCharacterAttributes", charId });
    expect(attrs.dexterity).toBe(16);
  });
});

describe("setAttrs worker reporting", () => {
  it("relays what onSheetWorkerCompleted reported rather than assuming", () => {
    const emu = shimEmu();
    const charId = emu.createCharacter("Bugbear", {});
    const res = emu.relay<SetAttrsResult>({ action: "setAttrs", charId, attributes: { strength: 15 } });
    // The shim runs no sheet workers and says so; the relay must not upgrade that to a guess.
    expect(res.workersExecuted).toBe(false);
    expect(res.silent).toBe(false);
    expect(res.note).toBeNull();
  });

  it("silent=true opts out of the worker path entirely and reports why", () => {
    const emu = shimEmu();
    const charId = emu.createCharacter("Kobold", {});
    const res = emu.relay<SetAttrsResult>({
      action: "setAttrs", charId, attributes: { strength: 9 }, silent: true,
    });
    expect(emu.setAttrsCalls[0].options).toEqual({ silent: true });
    expect(res.silent).toBe(true);
    // No hook is armed on a silent write, so there is nothing to report — null, never a bare false.
    expect(res.workersExecuted).toBeNull();
    expect(res.note).toMatch(/deliberately suppressed/);
  });

  it("reports the sheet context, so a null result stays interpretable", () => {
    const emu = shimEmu();
    emu.campaignModel.set("turnorder", "");
    const charId = emu.createCharacter("Zombie", {});
    const res = emu.relay<SetAttrsResult>({ action: "setAttrs", charId, attributes: { strength: 13 } });
    expect(res.sheet).toHaveProperty("beacon");
    expect(res.sheet).toHaveProperty("sandbox");
    expect(res.sheet).toHaveProperty("sheetName");
  });
});
