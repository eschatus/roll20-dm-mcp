// ─────────────────────────────────────────────────────────────────────────────
// Smoke integration — resolve_aoe, the one-call AoE batch resolver.
//
// Drives the REAL resolve_aoe MCP handler against the emulator (which runs the
// genuine mod-scripts/ai-relay.js sandbox), exercising the full chain the
// batch-reconcile refactor touched:
//   find targets in range -> roll NPC saves (rollFormulas) -> apply damage and
//   fail-conditions in ONE batchExec -> reconcile per-op results via
//   indexBatchResults -> DM report.
//
// PCs caught in the blast are report-only (never rolled/damaged); the center
// token is excluded by default (emanation semantics). LLM is not involved.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, seedWarband, type Harness, type Warband } from "./harness.js";

let h: Harness;
let w: Warband;

const hp = (id: string) => Number(h.emu.tokenProps(id).bar1_value);
const markers = (id: string) => String(h.emu.tokenProps(id).statusmarkers || "");

beforeAll(() => {
  h = setupHarness({ seed: 11 });
  w = seedWarband(h.emu);
});
afterAll(() => h.teardown());

describe("resolve_aoe batch resolver (integration)", () => {
  // A 15ft burst centered on the Hobgoblin Captain catches the two goblins and
  // the War Mage (NPCs), plus both PCs (report-only). The captain is the center
  // and is excluded by default.
  const burst = {
    label: "Fireball (War Mage)",
    centerTokenName: "Hobgoblin Captain",
    radiusFeet: 15,
    saveAbility: "dexterity",
    saveDc: 15,
    damageFormula: "8d6",
    halfOnSave: true,
  } as const;

  it("dryRun previews NPC + PC targets without rolling or applying anything", async () => {
    const before = {
      goblinA: hp(w.npcs.goblinA.id),
      goblinB: hp(w.npcs.goblinB.id),
      warmage: hp(w.npcs.warmage.id),
      fighter: hp(w.pcs.fighter.id),
      cleric: hp(w.pcs.cleric.id),
    };

    const { json } = await h.callTool("resolve_aoe", { ...burst, dryRun: true });
    const r = json as { wouldAffect: { npcs: string[]; pcs: string[]; skippedDown: string[] } };

    // NPCs in range are previewed; the front-line PC is split out as report-only.
    // (Sir Aldric at (10,10) is ~14ft from the captain at (8,8); Mother Vance at
    // (11,10) is ~18ft, outside the 15ft burst.)
    expect(r.wouldAffect.npcs).toContain("War Mage");
    expect(r.wouldAffect.npcs.filter((n) => n === "Goblin Cutter").length).toBeGreaterThanOrEqual(1);
    expect(r.wouldAffect.pcs).toContain("Sir Aldric");

    // dryRun mutates nothing.
    expect(hp(w.npcs.goblinA.id)).toBe(before.goblinA);
    expect(hp(w.npcs.goblinB.id)).toBe(before.goblinB);
    expect(hp(w.npcs.warmage.id)).toBe(before.warmage);
    expect(hp(w.pcs.fighter.id)).toBe(before.fighter);
    expect(hp(w.pcs.cleric.id)).toBe(before.cleric);
  });

  it("rolls saves, applies damage to NPCs via batchExec, and leaves PCs + center untouched", async () => {
    const warmageBefore = hp(w.npcs.warmage.id);
    const captainBefore = hp(w.npcs.captain.id); // center — must NOT be hit
    const fighterBefore = hp(w.pcs.fighter.id);
    const clericBefore = hp(w.pcs.cleric.id);

    const { text } = await h.callTool("resolve_aoe", burst);

    // Every NPC caught (8d6, half-on-save) loses HP — min damage is floor(8/2)=4 > 0.
    // The War Mage (22 HP) survives, so we can assert a strict decrease without a 0-clamp.
    expect(hp(w.npcs.warmage.id)).toBeLessThan(warmageBefore);

    // The center token is excluded by default (emanation semantics) — never damaged.
    expect(hp(w.npcs.captain.id)).toBe(captainBefore);

    // PCs in the blast are report-only — Beyond20 owns their bars, we never write them.
    expect(hp(w.pcs.fighter.id)).toBe(fighterBefore);
    expect(hp(w.pcs.cleric.id)).toBe(clericBefore);

    // DM report carries the label and per-NPC save lines rolled via Roll20's dice engine.
    expect(text).toContain("Fireball (War Mage)");
    expect(text).toMatch(/save \d+ vs DC 15/);

    // The blast point was drawn as a persistent zone.
    const zones = await h.callTool("list_zones");
    expect((zones.json as Array<{ name: string }>).some((z) => /Fireball/.test(z.name))).toBe(true);
  });

  it("no-save, condition-only mode applies a fail-condition to NPCs via batchExec", async () => {
    // targetNames mode + no saveAbility => everyone auto-fails => restrained applied,
    // zero damage. The captain was the (excluded) center above, so it's at full HP.
    const captainBefore = hp(w.npcs.captain.id);

    const { text } = await h.callTool("resolve_aoe", {
      label: "Web (caster)",
      targetNames: ["Hobgoblin Captain"],
      onFailCondition: "restrained",
    });

    expect(markers(w.npcs.captain.id)).toMatch(/Restrained/i);
    expect(hp(w.npcs.captain.id)).toBe(captainBefore); // condition-only: no HP change
    expect(text).toContain("Web (caster)");
    expect(text).toMatch(/\+restrained/);
  });
});
