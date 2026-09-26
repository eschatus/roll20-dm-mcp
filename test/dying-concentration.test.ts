// ─────────────────────────────────────────────────────────────────────────────
// Issue #135 — PC dying state + the concentration model.
//
//  - set_pc_dying: prone + unconscious, token STAYS on the token layer (never
//    dead, never map layer); rejects NPCs/sidekicks (use kill_token instead).
//  - break_concentration: removes the Concentrating marker, zeroes the aura slot the
//    effect OWNS (issue #210 — slot 1 unless set_token_aura recorded slot 2),
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
const aura2 = (id: string) => Number(h.emu.tokenProps(id).aura2_radius ?? 0);

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

// ─────────────────────────────────────────────────────────────────────────────
// Issue #210 — the teardown must know WHICH aura slot the concentration effect
// owns. set_token_aura takes slot 1 or 2 precisely so two overlapping
// emanations don't overwrite each other; a break that always zeroed slot 1 left
// a slot-2 ring on the map (and wiped an unrelated slot-1 aura on the way).
// ─────────────────────────────────────────────────────────────────────────────
describe("concentration aura slot ownership (#210)", () => {
  it("tears down slot 2 when the concentration effect claimed it, leaving slot 1 alone", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Sister Halder", controlledby: "player-halder",
      bar1_value: 28, bar1_max: 28, statusmarkers: "Concentrating::4444313",
    });
    const id = tokenId("Sister Halder");

    // Slot 1: an unrelated, permanent ring (a lantern's reach) — must survive.
    await h.callTool("set_token_aura", { characterName: "Sister Halder", radiusFeet: 10, slot: 1, color: "#ffdd88" });
    // Slot 2: the concentration spell itself.
    await h.callTool("set_token_aura", {
      characterName: "Sister Halder", radiusFeet: 15, slot: 2, color: "#66ccff",
      shape: "circle", concentration: true,
    });
    expect(aura(id)).toBe(10);
    expect(aura2(id)).toBe(15);

    const result = await h.callTool("break_concentration", { characterName: "Sister Halder" });
    const data = result.json as { auraCleared: boolean; auraSlot: number };

    expect(data.auraSlot).toBe(2);
    expect(data.auraCleared).toBe(true);
    expect(aura2(id)).toBe(0);  // the spell's ring is gone
    expect(aura(id)).toBe(10);  // the lantern is untouched
    expect(markers(id)).not.toMatch(/Concentrating::4444313/);
  });

  it("still defaults to slot 1 for a token with no recorded slot", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Old Rowan", controlledby: "player-rowan",
      bar1_value: 20, bar1_max: 20, statusmarkers: "Concentrating::4444313",
      aura1_radius: 30, aura2_radius: 5,
    });
    const id = tokenId("Old Rowan");

    const result = await h.callTool("break_concentration", { characterName: "Old Rowan" });
    const data = result.json as { auraCleared: boolean; auraSlot: number };

    expect(data.auraSlot).toBe(1);
    expect(data.auraCleared).toBe(true);
    expect(aura(id)).toBe(0);
    expect(aura2(id)).toBe(5); // never recorded as the spell's — left where it was
  });

  it("releases the slot when the aura is cleared, so a later break touches NEITHER slot", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Fen Tallow", controlledby: "player-fen",
      bar1_value: 18, bar1_max: 18, statusmarkers: "Concentrating::4444313",
    });
    const id = tokenId("Fen Tallow");

    // Slot 1: an unrelated permanent light ring — a released claim must NOT fall back onto it.
    await h.callTool("set_token_aura", { characterName: "Fen Tallow", radiusFeet: 10, slot: 1 });
    await h.callTool("set_token_aura", { characterName: "Fen Tallow", radiusFeet: 20, slot: 2, concentration: true });
    await h.callTool("set_token_aura", { characterName: "Fen Tallow", radiusFeet: 0, slot: 2 });
    // The DM repurposes slot 2 for something permanent afterwards.
    await h.callTool("set_token_aura", { characterName: "Fen Tallow", radiusFeet: 7, slot: 2, color: "#ffffff" });

    const result = await h.callTool("break_concentration", { characterName: "Fen Tallow" });
    const data = result.json as { auraSlot: number | null; auraCleared: boolean };
    expect(data.auraSlot).toBeNull();
    expect(data.auraCleared).toBe(false);
    expect(aura(id)).toBe(10); // the light ring survives
    expect(aura2(id)).toBe(7); // the repurposed ring survives
  });

  it("releases the slot when it is reused for a NON-concentration aura", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Cobb Wexley", controlledby: "player-cobb",
      bar1_value: 18, bar1_max: 18, statusmarkers: "Concentrating::4444313",
    });
    const id = tokenId("Cobb Wexley");

    await h.callTool("set_token_aura", { characterName: "Cobb Wexley", radiusFeet: 20, slot: 2, concentration: true });
    // Same slot, overwritten by a marching-order marker that is NOT the spell.
    await h.callTool("set_token_aura", { characterName: "Cobb Wexley", radiusFeet: 5, slot: 2, concentration: false });

    const result = await h.callTool("break_concentration", { characterName: "Cobb Wexley" });
    expect((result.json as { auraSlot: number | null }).auraSlot).toBeNull();
    expect(aura2(id)).toBe(5);
  });

  it("recasting onto the other slot clears the ring the spell used to own", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Ilse Marrow", controlledby: "player-ilse",
      bar1_value: 24, bar1_max: 24, statusmarkers: "Concentrating::4444313",
    });
    const id = tokenId("Ilse Marrow");

    await h.callTool("set_token_aura", { characterName: "Ilse Marrow", radiusFeet: 15, slot: 1, concentration: true });
    await h.callTool("set_token_aura", { characterName: "Ilse Marrow", radiusFeet: 20, slot: 2, concentration: true });
    expect(aura(id)).toBe(0);   // the old ring went with the claim
    expect(aura2(id)).toBe(20);

    const result = await h.callTool("break_concentration", { characterName: "Ilse Marrow" });
    expect((result.json as { auraSlot: number }).auraSlot).toBe(2);
    expect(aura2(id)).toBe(0);
  });

  it("a raw set_token_props write over the claimed slot releases the claim", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Tobin Ashe", controlledby: "player-tobin",
      bar1_value: 20, bar1_max: 20, statusmarkers: "Concentrating::4444313",
    });
    const id = tokenId("Tobin Ashe");

    await h.callTool("set_token_aura", { characterName: "Tobin Ashe", radiusFeet: 15, slot: 2, concentration: true });
    // The DM replaces the spell's ring with a permanent 5 ft one through the raw props route.
    await h.callTool("set_token_props", { characterName: "Tobin Ashe", aura2_radius: 5 });
    expect(aura2(id)).toBe(5);

    const result = await h.callTool("break_concentration", { characterName: "Tobin Ashe" });
    expect((result.json as { auraSlot: number | null }).auraSlot).toBeNull();
    expect(aura2(id)).toBe(5); // the permanent ring is left alone
  });

  it("a second break after a teardown does not fall back onto slot 1", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Wren Hollis", controlledby: "player-wren",
      bar1_value: 20, bar1_max: 20, statusmarkers: "Concentrating::4444313", aura1_radius: 10,
    });
    const id = tokenId("Wren Hollis");

    await h.callTool("set_token_aura", { characterName: "Wren Hollis", radiusFeet: 15, slot: 2, concentration: true });
    await h.callTool("break_concentration", { characterName: "Wren Hollis" });
    expect(aura2(id)).toBe(0);

    const again = await h.callTool("break_concentration", { characterName: "Wren Hollis" });
    expect((again.json as { auraSlot: number | null }).auraSlot).toBeNull();
    expect(aura(id)).toBe(10);
  });

  it("set_pc_dying cascades the teardown onto the recorded slot", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Perrin Vale", controlledby: "player-perrin",
      bar1_value: 0, bar1_max: 22, statusmarkers: "Concentrating::4444313",
    });
    const id = tokenId("Perrin Vale");
    await h.callTool("set_token_aura", { characterName: "Perrin Vale", radiusFeet: 15, slot: 2, concentration: true });

    const { text } = await h.callTool("set_pc_dying", { characterName: "Perrin Vale" });

    expect(aura2(id)).toBe(0);
    expect(text).toMatch(/aura 2 cleared=true/i);
  });

  it("set_token_aura writes shape and visibility through the relay", async () => {
    h.emu.createToken({ pageid: pageId, name: "Shape Test", controlledby: "", bar1_value: 9, bar1_max: 9 });
    const id = tokenId("Shape Test");

    await h.callTool("set_token_aura", {
      characterName: "Shape Test", radiusFeet: 10, slot: 2, color: "#00ff00",
      shape: "square", visibleToPlayers: false,
    });
    const props = h.emu.tokenProps(id);
    expect(Number(props.aura2_radius)).toBe(10);
    expect(props.aura2_color).toBe("#00ff00");
    expect(props.aura2_options).toBe("square");
    // _options is authoritative and Roll20 keeps _square in sync itself — never write both.
    // "" is the emulator's never-written value; a _square write would have stored true.
    expect(props.aura2_square).toBe("");
    expect(props.showplayers_aura2).toBe(false);
  });

  it("resolve_aoe draw:'aura' honours auraSlot/auraShape and can claim the slot for concentration", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Dawn Caller", controlledby: "player-dawn",
      bar1_value: 26, bar1_max: 26, statusmarkers: "Concentrating::4444313", left: 500, top: 500,
    });
    const id = tokenId("Dawn Caller");

    await h.callTool("resolve_aoe", {
      label: "Spirit Guardians", centerTokenName: "Dawn Caller", radiusFeet: 15,
      draw: "aura", auraSlot: 2, auraShape: "circle", auraConcentration: true,
      dryRun: false, damage: 0, pageId,
    });
    expect(aura2(id)).toBe(15);
    expect(h.emu.tokenProps(id).aura2_options).toBe("circle");

    const result = await h.callTool("break_concentration", { characterName: "Dawn Caller" });
    expect((result.json as { auraSlot: number }).auraSlot).toBe(2);
    expect(aura2(id)).toBe(0);
  });

  // ── Untagged callers keep master's behaviour (review of #220) ──────────────────────────────
  // A caller that never sends concentration:true — the pinned gem, resolve_aoe's default — must
  // get a slot-1 teardown on EVERY break, not just the first. A break leaves a released (0)
  // claim; an untagged slot-1 ring drawn afterwards resets the token to untracked.

  it("untagged slot-1 aura → break, repeated: the ring is torn down every time", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Maud Crane", controlledby: "player-maud",
      bar1_value: 22, bar1_max: 22,
    });
    const id = tokenId("Maud Crane");

    for (let round = 1; round <= 3; round++) {
      await h.callTool("set_token_marker", { characterName: "Maud Crane", condition: "concentrating", active: true });
      await h.callTool("set_token_aura", { characterName: "Maud Crane", radiusFeet: 15 });
      expect(aura(id)).toBe(15);

      const result = await h.callTool("break_concentration", { characterName: "Maud Crane" });
      const data = result.json as { auraSlot: number | null; auraCleared: boolean };
      expect({ round, auraSlot: data.auraSlot, auraCleared: data.auraCleared }).toEqual({ round, auraSlot: 1, auraCleared: true });
      expect(aura(id)).toBe(0);
    }
  });

  it("a raw set_token_props slot-1 ring after a break is torn down by the next break", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Hesper Lark", controlledby: "player-hesper",
      bar1_value: 22, bar1_max: 22, statusmarkers: "Concentrating::4444313", aura1_radius: 10,
    });
    const id = tokenId("Hesper Lark");

    await h.callTool("break_concentration", { characterName: "Hesper Lark" });
    expect(aura(id)).toBe(0);
    await h.callTool("set_token_props", { characterName: "Hesper Lark", aura1_radius: 20 });

    const result = await h.callTool("break_concentration", { characterName: "Hesper Lark" });
    expect((result.json as { auraSlot: number | null }).auraSlot).toBe(1);
    expect(aura(id)).toBe(0);
  });

  it("after a prior break, resolve_aoe draw:'aura' with the default auraConcentration is still torn down", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Brother Oswin", controlledby: "player-oswin",
      bar1_value: 26, bar1_max: 26, statusmarkers: "Concentrating::4444313", left: 800, top: 800,
    });
    const id = tokenId("Brother Oswin");

    // An earlier, unrelated break leaves the token's claim released.
    await h.callTool("break_concentration", { characterName: "Brother Oswin" });

    await h.callTool("set_token_marker", { characterName: "Brother Oswin", condition: "concentrating", active: true });
    await h.callTool("resolve_aoe", {
      label: "Spirit Guardians", centerTokenName: "Brother Oswin", radiusFeet: 15,
      draw: "aura", dryRun: false, damage: 0, pageId,
    });
    expect(aura(id)).toBe(15);

    const result = await h.callTool("break_concentration", { characterName: "Brother Oswin" });
    const data = result.json as { auraSlot: number | null; auraCleared: boolean };
    expect(data.auraSlot).toBe(1);
    expect(data.auraCleared).toBe(true);
    expect(aura(id)).toBe(0);
  });

  it("an untagged slot-2 ring after a break does NOT reset the claim onto slot 1", async () => {
    h.emu.createToken({
      pageid: pageId, name: "Quill Harrow", controlledby: "player-quill",
      bar1_value: 20, bar1_max: 20, statusmarkers: "Concentrating::4444313", aura1_radius: 10,
    });
    const id = tokenId("Quill Harrow");

    await h.callTool("set_token_aura", { characterName: "Quill Harrow", radiusFeet: 15, slot: 2, concentration: true });
    await h.callTool("break_concentration", { characterName: "Quill Harrow" });
    await h.callTool("set_token_aura", { characterName: "Quill Harrow", radiusFeet: 5, slot: 2 });

    const result = await h.callTool("break_concentration", { characterName: "Quill Harrow" });
    expect((result.json as { auraSlot: number | null }).auraSlot).toBeNull();
    expect(aura(id)).toBe(10);  // unrelated slot-1 ring survives
    expect(aura2(id)).toBe(5);  // the untagged slot-2 ring survives
  });
});
