// ─────────────────────────────────────────────────────────────────────────────
// Issue #135 — PC dying state + the concentration model.
//
//  - set_pc_dying: prone + unconscious, token STAYS on the token layer (never
//    dead, never map layer); rejects NPCs/sidekicks (use kill_token instead).
//  - break_concentration: removes the Concentrating marker, zeroes aura1_radius,
//    deletes only zones whose duration is {type:"concentration", caster}
//    linked to that token — other zones untouched.
//  - set_pc_dying auto-cascades break_concentration when the PC was concentrating
//    (going down breaks it implicitly).
//  - Revival: clearing 'unconscious' via set_token_marker leaves 'prone' in place.
//  - kill_token still works for an explicit DM death declaration (3 failed saves).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import * as characters from "../src/registry/characters.js";

let h: Harness;
let pageId: string;

const markers = (id: string) => String(h.emu.tokenProps(id).statusmarkers ?? "");
const layer = (id: string) => String(h.emu.tokenProps(id).layer ?? "");
const aura = (id: string) => Number(h.emu.tokenProps(id).aura1_radius ?? 0);

function tokenId(name: string): string {
  const tokens = h.emu.relay<Array<{ id: string; name: string }>>({ action: "getTokens", pageId });
  const tok = tokens.find((t) => t.name === name);
  if (!tok) throw new Error(`Token not found in emulator: ${name}`);
  return tok.id;
}

beforeAll(() => {
  h = setupHarness({ seed: 135 });
  pageId = h.emu.createPage("Dying/Concentration Tests");
  h.emu.setPlayerPage(pageId);

  // A true PC — player-controlled, NOT flagged sidekick.
  h.emu.createToken({
    pageid: pageId, name: "Thorne", controlledby: "player-thorne",
    bar1_value: 0, bar1_max: 24,
  });

  // A concentrating PC caster (for the auto-cascade + declarative break tests).
  h.emu.createToken({
    pageid: pageId, name: "Glint", controlledby: "player-glint",
    bar1_value: 0, bar1_max: 20,
    statusmarkers: "Concentrating::4444313",
    aura1_radius: 15,
  });

  // A sidekick and an NPC — both should reject set_pc_dying.
  h.emu.createToken({ pageid: pageId, name: "Tua", controlledby: "player-glint", bar1_value: 0, bar1_max: 22 });
  characters.setSidekick("Tua", true);
  h.emu.createToken({ pageid: pageId, name: "Goblin Cutter", controlledby: "", bar1_value: 0, bar1_max: 7 });
});

afterAll(() => h.teardown());

describe("set_pc_dying — PC dying state", () => {
  it("applies prone + unconscious and keeps the token on the token layer", async () => {
    const id = tokenId("Thorne");
    expect(layer(id)).not.toBe("map");

    const { text } = await h.callTool("set_pc_dying", { characterName: "Thorne" });

    expect(markers(id)).toMatch(/Prone::4444315/);
    expect(markers(id)).toMatch(/Unconscious::4444317/);
    expect(layer(id)).not.toBe("map"); // never moved to the map layer
    expect(text).toMatch(/dying/i);
    expect(text).toMatch(/death saves are player-owned/i);
  });

  it("rejects a sidekick — points at kill_token instead", async () => {
    await expect(h.callTool("set_pc_dying", { characterName: "Tua" })).rejects.toThrow(/kill_token/i);
  });

  it("rejects an NPC — points at kill_token instead", async () => {
    await expect(h.callTool("set_pc_dying", { characterName: "Goblin Cutter" })).rejects.toThrow(/kill_token/i);
  });

  it("auto-cascades break_concentration when the downed PC was concentrating", async () => {
    const glintId = tokenId("Glint");

    // Link a concentration zone to Glint before he drops.
    await h.callTool("create_zone", {
      name: "Spirit Guardians (Glint)",
      duration: { type: "concentration", caster: "Glint" },
      centerX: 0, centerY: 0, pageId,
    });
    const before = await h.callTool("list_zones", { pageId });
    expect((before.json as Array<{ name: string }>).some((z) => z.name.includes("Spirit Guardians"))).toBe(true);

    const { text } = await h.callTool("set_pc_dying", { characterName: "Glint" });

    expect(markers(glintId)).toMatch(/Prone::4444315/);
    expect(markers(glintId)).toMatch(/Unconscious::4444317/);
    expect(markers(glintId)).not.toMatch(/Concentrating::4444313/); // cascade removed it
    expect(aura(glintId)).toBe(0); // cascade zeroed the aura
    expect(text).toMatch(/concentration broken/i);

    const after = await h.callTool("list_zones", { pageId });
    expect((after.json as Array<{ name: string }>).some((z) => z.name.includes("Spirit Guardians"))).toBe(false);
  });
});

describe("break_concentration — teardown cascade", () => {
  it("removes the marker, zeroes the aura, and deletes only the linked zone", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Mother Vance", controlledby: "player-vance",
      bar1_value: 24, bar1_max: 24, statusmarkers: "Concentrating::4444313", aura1_radius: 20,
    });
    const id = tokenId("Mother Vance");

    await h.callTool("create_zone", {
      name: "Bless Aura",
      duration: { type: "concentration", caster: "Mother Vance" },
      centerX: 10, centerY: 10, pageId,
    });
    // An unrelated zone (different caster) must survive.
    await h.callTool("create_zone", {
      name: "Unrelated Web",
      duration: { type: "concentration", caster: "Someone Else" },
      centerX: 20, centerY: 20, pageId,
    });

    const result = await h.callTool("break_concentration", { characterName: "Mother Vance" });
    const data = result.json as { markerRemoved: boolean; auraCleared: boolean; zonesRemoved: Array<{ name: string }> };
    expect(data.markerRemoved).toBe(true);
    expect(data.auraCleared).toBe(true);
    expect(data.zonesRemoved).toHaveLength(1);
    expect(data.zonesRemoved[0].name).toContain("Bless Aura");

    expect(markers(id)).not.toMatch(/Concentrating::4444313/);
    expect(aura(id)).toBe(0);

    const listed = await h.callTool("list_zones", { pageId });
    const names = (listed.json as Array<{ name: string }>).map((z) => z.name);
    expect(names.some((n) => n.includes("Bless Aura"))).toBe(false);
    expect(names.some((n) => n.includes("Unrelated Web"))).toBe(true); // untouched
  });

  it("is a no-op (but doesn't throw) on a token that wasn't concentrating", async () => {
    h.emu.createToken({ pageid: pageId, name: "Sir Aldric", controlledby: "player-aldric", bar1_value: 30, bar1_max: 30 });
    const result = await h.callTool("break_concentration", { characterName: "Sir Aldric" });
    const data = result.json as { markerRemoved: boolean; auraCleared: boolean; zonesRemoved: Array<unknown> };
    expect(data.markerRemoved).toBe(false);
    expect(data.auraCleared).toBe(false);
    expect(data.zonesRemoved).toHaveLength(0);
  });
});

describe("revival semantics", () => {
  it("clearing unconscious leaves prone in place", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Brie Mossfrond", controlledby: "player-brie",
      bar1_value: 0, bar1_max: 18,
    });
    await h.callTool("set_pc_dying", { characterName: "Brie Mossfrond" });
    const id = tokenId("Brie Mossfrond");
    expect(markers(id)).toMatch(/Prone::4444315/);
    expect(markers(id)).toMatch(/Unconscious::4444317/);

    await h.callTool("set_token_marker", { characterName: "Brie Mossfrond", condition: "unconscious", active: false });

    expect(markers(id)).not.toMatch(/Unconscious::4444317/);
    expect(markers(id)).toMatch(/Prone::4444315/); // stays until the DM says otherwise
  });
});

describe("kill_token — explicit death declaration still works for a PC", () => {
  it("marks a PC dead and moves it to the map layer on the DM's explicit say-so", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Doomed Rook", controlledby: "player-rook",
      bar1_value: 0, bar1_max: 16,
    });
    await h.callTool("set_pc_dying", { characterName: "Doomed Rook" });
    const id = tokenId("Doomed Rook");
    expect(layer(id)).not.toBe("map");

    await h.callTool("kill_token", { characterName: "Doomed Rook" });

    expect(layer(id)).toBe("map");
    expect(markers(id)).toMatch(/Unconscious::4444317/); // "dead" shares the marker tag
  });
});
