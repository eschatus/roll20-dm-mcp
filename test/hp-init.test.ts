// ─────────────────────────────────────────────────────────────────────────────
// #5 — NPC tokens with null HP bars.
//
// Two halves, both against the real emulator:
//  1. roll_initiative auto-initializes bar1/bar1_max from DDB average HP for any
//     NPC combatant placed without one (ddb.getMonster is mocked here so the
//     average is deterministic and no network is touched). PCs are never touched.
//  2. resolve_aoe / update_token_hp / update_hp_many surface "no HP bar" instead
//     of silently writing 0 to a bar-less token.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Mock only getMonster; keep the rest of the DDB bridge real.
vi.mock("../src/bridge/dndbeyond.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bridge/dndbeyond.js")>();
  return {
    ...actual,
    getMonster: vi.fn(async (nameOrId: string | number) => {
      const n = String(nameOrId).toLowerCase();
      if (n.includes("dire wolf")) {
        return { id: 1, name: "Dire Wolf", averageHitPoints: 37, armorClass: 14, challengeRating: "1", largeAvatarUrl: null };
      }
      throw new Error(`Monster not found: ${nameOrId}`);
    }),
  };
});

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

describe("roll_initiative HP auto-init (#5)", () => {
  it("initializes a bar-less NPC from DDB average HP and reports it", async () => {
    const wolf = h.emu.createToken({ pageid: w.pageId, name: "Dire Wolf", controlledby: "", left: 200, top: 200 });
    expect(max(wolf.id)).toBe(0); // no bar to start

    const { json } = await h.callTool("roll_initiative", { nameFilter: "dire wolf", initHp: true, publicRoll: false });
    const r = json as { hpInitialized?: string[]; hpLookupFailed?: string[] };

    expect(max(wolf.id)).toBe(37);
    expect(val(wolf.id)).toBe(37);
    expect(r.hpInitialized).toContain("Dire Wolf → 37");
  });

  it("flags an NPC the compendium doesn't know and leaves its bar untouched", async () => {
    const beast = h.emu.createToken({ pageid: w.pageId, name: "Mystery Beast", controlledby: "", left: 340, top: 200 });

    const { json } = await h.callTool("roll_initiative", { nameFilter: "mystery beast", initHp: true, publicRoll: false });
    const r = json as { hpInitialized?: string[]; hpLookupFailed?: string[] };

    expect(max(beast.id)).toBe(0); // still no bar — graceful, not a phantom
    expect(r.hpLookupFailed).toContain("Mystery Beast");
  });

  it("never initializes a PC-controlled token, even with npcOnly:false", async () => {
    const ghost = h.emu.createToken({ pageid: w.pageId, name: "Dire Wolf Familiar", controlledby: w.playerId, left: 410, top: 200 });

    const { json } = await h.callTool("roll_initiative", { nameFilter: "familiar", npcOnly: false, initHp: true, publicRoll: false });
    const r = json as { hpInitialized?: string[] };

    // Name would match the DDB mock, but the PC guard skips it: bar stays unset.
    expect(max(ghost.id)).toBe(0);
    expect(r.hpInitialized ?? []).not.toContain("Dire Wolf Familiar → 37");
  });

  it("skips the DDB lookups entirely when initHp:false", async () => {
    const wolf2 = h.emu.createToken({ pageid: w.pageId, name: "Dire Wolf", controlledby: "", left: 480, top: 200 });

    const { json } = await h.callTool("roll_initiative", { nameFilter: "dire wolf", initHp: false, publicRoll: false });
    const r = json as { hpInitialized?: string[] };

    expect(max(wolf2.id)).toBe(0);
    expect(r.hpInitialized).toBeUndefined();
  });
});

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
