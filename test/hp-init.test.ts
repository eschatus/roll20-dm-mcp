// ─────────────────────────────────────────────────────────────────────────────
// #5 — NPC tokens with null HP bars.
//
// The other half of this file used to cover roll_initiative's DDB average-HP
// auto-init. That path is gone with the DDB bridge (#171 Phase 2) — callers pass
// entries[].hp instead, covered by test/initiative-entries.test.ts.
//
// What remains is the guard that outlived it: resolve_aoe / update_token_hp /
// update_hp_many must SURFACE a bar-less token instead of silently writing 0 to it.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { setupHarness, seedWarband, type Harness, type Warband } from "./harness.js";

let h: Harness;
let w: Warband;
const max = (id: string) => Number(h.emu.tokenProps(id).bar1_max);
const val = (id: string) => Number(h.emu.tokenProps(id).bar1_value);

beforeAll(() => {
  h = setupHarness({ seed: 7 });
  w = seedWarband(h.emu);
});
afterAll(() => h.teardown());

describe("no-HP-bar warnings (#5)", () => {
  it("resolve_aoe reports a bar-less target as not-applied instead of a phantom hit", async () => {
    const skel = h.emu.createToken({ pageid: w.pageId, name: "Barless Skeleton", controlledby: "", left: 550, top: 200 });

    const { text } = await h.callTool("resolve_aoe", {
      label: "Fireball (test)",
      targetNames: ["Barless Skeleton"],
      damage: 12,
    });

    expect(text).toMatch(/Barless Skeleton:.*NOT applied \(no HP bar/);
    expect(max(skel.id)).toBe(0); // nothing written
    expect(val(skel.id)).toBe(0);
  });

  it("update_token_hp refuses damage on a bar-less token but allows setHp to establish one", async () => {
    const zombie = h.emu.createToken({ pageid: w.pageId, name: "Barless Zombie", controlledby: "", left: 620, top: 200 });

    const dmg = await h.callTool("update_token_hp", { tokenId: zombie.id, damage: 8 });
    expect(dmg.text).toMatch(/no HP bar/);
    expect(val(zombie.id)).toBe(0);

    const set = await h.callTool("update_token_hp", { tokenId: zombie.id, setHp: 22 });
    expect(set.text).not.toMatch(/no HP bar/);
    expect(val(zombie.id)).toBe(22);
  });

  it("update_hp_many separates bar-less tokens out of the applied count", async () => {
    const g1 = h.emu.createToken({ pageid: w.pageId, name: "Barless Ghoul A", controlledby: "", left: 690, top: 200 });
    const g2 = h.emu.createToken({ pageid: w.pageId, name: "Barless Ghoul B", controlledby: "", left: 760, top: 200, bar1_value: 22, bar1_max: 22 });

    const { text } = await h.callTool("update_hp_many", { nameMatch: "Barless Ghoul", damage: 10 });

    // Only the token with a bar takes damage; the other is reported as no-bar.
    expect(text).toMatch(/applied to 1\/2/);
    expect(text).toMatch(/no HP bar: Barless Ghoul A/);
    expect(val(g1.id)).toBe(0);
    expect(val(g2.id)).toBe(12);
  });
});
