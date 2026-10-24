// ─────────────────────────────────────────────────────────────────────────────
// Issue #242 — PC classification must consider the REPRESENTED CHARACTER's
// controlledby, not just the token's own.
//
// In Roll20 "Can Be Edited & Controlled By" on a character sheet gives a player
// control of every token linked to it, so the linked token's own `controlledby`
// is routinely blank (Zarya Goldentooth, Heinz Craft). Reading only the token
// classed those PCs as NPCs: HP went to bar1 (Beyond20 owns a PC's bar),
// npcOnly initiative rolled them like monsters, kill_token skipped dying.
//
// Drives the real tool handlers against the emulator (ai-relay.js in a vm).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import * as characters from "../src/registry/characters.js";
import { classifyToken } from "../src/tools/aoe.js";
import { resolveCharControl, withCharControl } from "../src/bridge/rt-helpers.js";

let h: Harness;
let pageId: string;

const bar = (id: string) => Number(h.emu.tokenProps(id).bar1_value);
const gmnotes = (id: string) => String(h.emu.tokenProps(id).gmnotes ?? "");

function tokenId(name: string): string {
  const tokens = h.emu.relay<Array<{ id: string; name: string }>>({ action: "getTokens", pageId });
  const tok = tokens.find((t) => t.name === name);
  if (!tok) throw new Error(`Token not found in emulator: ${name}`);
  return tok.id;
}

beforeAll(() => {
  h = setupHarness({ seed: 242 });
  pageId = h.emu.createPage("Char Control Tests");
  h.emu.setPlayerPage(pageId);

  // Sheet-controlled PC: token controlledby blank, character controlledby = player.
  const zarya = h.emu.createCharacter("Zarya Goldentooth", {}, "player-abi");
  h.emu.createToken({ pageid: pageId, name: "Zarya Goldentooth", represents: zarya, controlledby: "", bar1_value: 40, bar1_max: 40 });

  // Real NPC: sheet with no controller, token with none.
  const ogre = h.emu.createCharacter("Ogre", {}, "");
  h.emu.createToken({ pageid: pageId, name: "Ogre", represents: ogre, controlledby: "", bar1_value: 59, bar1_max: 59 });

  // Sheet controlled by "all" is scenery/summon, not a PC.
  const shared = h.emu.createCharacter("Shared Summon", {}, "all");
  h.emu.createToken({ pageid: pageId, name: "Shared Summon", represents: shared, controlledby: "", bar1_value: 10, bar1_max: 10 });

  // Sheet-controlled sidekick: override must still win.
  const tua = h.emu.createCharacter("Tua", {}, "player-abi");
  h.emu.createToken({ pageid: pageId, name: "Tua", represents: tua, controlledby: "", bar1_value: 22, bar1_max: 22 });
  characters.setSidekick("Tua", true);
});

afterAll(() => h.teardown());

describe("list_tokens classification from the character sheet", () => {
  it("classes tokens by token controlledby UNION character controlledby", async () => {
    const { json } = await h.callTool("list_tokens", { pageId });
    const cls = Object.fromEntries((json as Array<{ name: string; tokenClass: string }>).map((t) => [t.name, t.tokenClass]));
    expect(cls["Zarya Goldentooth"]).toBe("pc");
    expect(cls["Ogre"]).toBe("npc");
    expect(cls["Shared Summon"]).toBe("npc");
    expect(cls["Tua"]).toBe("sidekick");
  });
});

describe("classifyToken (pure)", () => {
  it("unions token and character controllers", () => {
    expect(classifyToken({ id: "1", name: "A", controlledby: "", charControlledby: "p1" })).toBe("pc");
    expect(classifyToken({ id: "1", name: "A", controlledby: "p1", charControlledby: "" })).toBe("pc");
    expect(classifyToken({ id: "1", name: "A", controlledby: "", charControlledby: "all" })).toBe("npc");
    expect(classifyToken({ id: "1", name: "A", controlledby: "all", charControlledby: "all,p1" })).toBe("pc");
    expect(classifyToken({ id: "1", name: "A", controlledby: "", charControlledby: "p1" }, new Set(["a"]))).toBe("sidekick");
  });
});

describe("HP routing for a sheet-controlled PC", () => {
  it("update_token_hp tracks in gmnotes and never writes the bar", async () => {
    const id = tokenId("Zarya Goldentooth");
    const { text } = await h.callTool("update_token_hp", { tokenId: id, damage: 8 });
    expect(bar(id)).toBe(40);
    const m = gmnotes(id).match(/%%PCHP=(\{[\s\S]*?\})%%/);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]).current).toBe(32);
    expect(text).toMatch(/\(tracked\)/);
  });

  it("update_hp_many routes the sheet-controlled PC to tracking and the ogre to bar1", async () => {
    const zid = tokenId("Zarya Goldentooth");
    const oid = tokenId("Ogre");
    await h.callTool("update_hp_many", { names: ["Zarya Goldentooth", "Ogre"], damage: 4 });
    expect(bar(zid)).toBe(40);
    expect(bar(oid)).toBe(55);
  });

  it("the sidekick override still wins over sheet control (bar1, no tracked block)", async () => {
    const id = tokenId("Tua");
    await h.callTool("update_token_hp", { tokenId: id, damage: 12 });
    expect(bar(id)).toBe(10);
    expect(gmnotes(id)).not.toMatch(/PCHP/);
  });
});

describe("roll_initiative npcOnly skips the sheet-controlled PC", () => {
  it("does not roll Zarya like a monster", async () => {
    await h.callTool("roll_initiative", { npcOnly: true, clearFirst: true, publicRoll: false });
    const to = h.emu.relay<Array<{ id: string }>>({ action: "getTurnOrder" });
    expect(to.map((e) => e.id)).not.toContain(tokenId("Zarya Goldentooth"));
    expect(to.map((e) => e.id)).toContain(tokenId("Ogre"));
  });
});

describe("RT direct reads resolve the character controlledby per distinct id", () => {
  it("reads each distinct represents id once, treats absent as empty, and attaches like tokenSummary", async () => {
    const calls: string[] = [];
    const store: Record<string, unknown> = { cA: "player-abi", cB: "all", cC: null };
    const rows = [
      { id: "1", represents: "cA" }, { id: "2", represents: "cA" },
      { id: "3", represents: "cB" }, { id: "4", represents: "cC" }, { id: "5", represents: "" },
    ];
    const ctl = await resolveCharControl(rows, async (id) => { calls.push(id); return store[id]; });
    expect(calls.sort()).toEqual(["cA", "cB", "cC"]);
    expect(withCharControl({ id: "1" }, "cA", ctl)).toEqual({ id: "1", charControlledby: "player-abi" });
    expect(withCharControl({ id: "3" }, "cB", ctl)).toEqual({ id: "3", charControlledby: "all" });
    expect(withCharControl({ id: "4" }, "cC", ctl)).toEqual({ id: "4" });
    expect(withCharControl({ id: "5" }, "", ctl)).toEqual({ id: "5" });
  });

  it("a failing per-id read rejects instead of guessing a class", async () => {
    await expect(resolveCharControl([{ represents: "cA" }], async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});
