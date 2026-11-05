// ─────────────────────────────────────────────────────────────────────────────
// PC HP on Roll20's own character sheets — the opt-in carrier (src/tools/pcHp.ts).
//
// Default tables keep PC HP in a tracked gmnotes block. A campaign switched to source "sheet"
// reads and writes a sheet field instead, on both an attribute-backed sheet and a Beacon sheet
// holding HP in a computed property. In both modes the token bar is never written, and a refused
// write changes nothing. NPCs and sidekicks stay on bar1 whichever mode is on.
//
// The live half is src/recon/pc-sheet-hp-it.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setupHarness, type Harness } from "./harness.js";
import * as campaigns from "../src/registry/campaigns.js";
import * as characters from "../src/registry/characters.js";
import { registerCampaignTools } from "../src/tools/campaigns.js";
import { applyHpOp } from "../src/tools/pcHp.js";

let h: Harness;
let pageId: string;
let charId: string;

const props = (id: string) => h.emu.tokenProps(id);
const sheet = async (name: string, valtype = "current") =>
  (await h.emu.relayAsync<{ values: Record<string, unknown> }>({ action: "getSheetItem", charId, names: [name], valtype })).values[name];
const setSheet = (attributes: Record<string, unknown>) => h.emu.relayAsync({ action: "setSheetItem", charId, attributes });

function makePc(name: string, represents: string): string {
  const t = h.emu.createToken({
    pageid: pageId, name, controlledby: "player-1", represents, layer: "objects",
    bar1_value: 7, bar1_max: 7, left: 70, top: 70,
  });
  return t.id;
}

beforeAll(() => {
  campaigns.registerCampaign("Sheet Table", "99001");
  campaigns.setActiveCampaign("sheet-table");
});

beforeEach(async () => {
  h = setupHarness({ seed: 300 });
  registerCampaignTools(h.server as unknown as McpServer);
  h.emu.installSheetCarriers({ sandboxVersion: "1.0" });
  pageId = h.emu.createPage("Sheet HP");
  h.emu.setPlayerPage(pageId);
  charId = h.emu.createCharacter("Brie", {}, "player-1");
  await setSheet({ hp: { current: 30, max: 44 } });
  campaigns.setPcSheetHp("hp");
});

afterAll(() => {
  campaigns.setPcSheetHp(null);
  h.teardown();
});

describe("update_token_hp on the sheet carrier", () => {
  it("damage reads and writes the sheet, and leaves the bar and gmnotes alone", async () => {
    const id = makePc("Brie", charId);
    const { text } = await h.callTool("update_token_hp", { tokenId: id, damage: 12 });
    expect(await sheet("hp")).toBe(18);
    expect(text).toContain("18/44 (sheet)");
    expect(Number(props(id).bar1_value)).toBe(7);
    expect(String(props(id).gmnotes ?? "")).not.toContain("%%PCHP");
  });

  it("clamps damage at 0 and healing at the sheet's max", async () => {
    const id = makePc("Brie", charId);
    await h.callTool("update_token_hp", { tokenId: id, damage: 99 });
    expect(await sheet("hp")).toBe(0);
    await h.callTool("update_token_hp", { tokenId: id, heal: 500 });
    expect(await sheet("hp")).toBe(44);
  });

  it("setHp writes the absolute value and establishes a blank field", async () => {
    await setSheet({ hp: "" });
    const id = makePc("Brie", charId);
    await h.callTool("update_token_hp", { tokenId: id, setHp: 21 });
    expect(await sheet("hp")).toBe(21);
  });

  it("reads a numeric string the way a sheet stores it", async () => {
    await setSheet({ hp: { current: "30", max: "44" } });
    const id = makePc("Brie", charId);
    await h.callTool("update_token_hp", { tokenId: id, damage: 5 });
    expect(await sheet("hp")).toBe(25);
  });

  it("works with no max on the sheet: healing is unclamped, as on a bar with none", async () => {
    const other = h.emu.createCharacter("Noor", {}, "player-1");
    await h.emu.relayAsync({ action: "setSheetItem", charId: other, attributes: { hp: 10 } });
    const id = makePc("Noor", other);
    const { text } = await h.callTool("update_token_hp", { tokenId: id, heal: 5 });
    expect(text).toContain("15 (sheet)");
  });

  it("uses a configured field name", async () => {
    await setSheet({ hit_points: { current: 9, max: 9 } });
    campaigns.setPcSheetHp("hit_points");
    const id = makePc("Brie", charId);
    await h.callTool("update_token_hp", { tokenId: id, damage: 2 });
    expect(await sheet("hit_points")).toBe(7);
    expect(await sheet("hp")).toBe(30);
  });
});

describe("a write that cannot be done changes nothing and says so", () => {
  it("refuses a token linked to no sheet", async () => {
    const id = makePc("Brie", "");
    await expect(h.callTool("update_token_hp", { tokenId: id, damage: 3 })).rejects.toThrow(/represents no character/);
    expect(await sheet("hp")).toBe(30);
  });

  it("refuses a value that is not a number instead of reading it as 0", async () => {
    await setSheet({ hp: "2d6+3" });
    const id = makePc("Brie", charId);
    await expect(h.callTool("update_token_hp", { tokenId: id, damage: 3 })).rejects.toThrow(/not a number/);
    expect(await sheet("hp")).toBe("2d6+3");
  });

  it("refuses damage against a blank field", async () => {
    await setSheet({ hp: "" });
    const id = makePc("Brie", charId);
    await expect(h.callTool("update_token_hp", { tokenId: id, damage: 3 })).rejects.toThrow(/not a number/);
  });

  it("catches a write the sheet reports as landed and drops, as a live Beacon sheet does", async () => {
    h.teardown();
    h = setupHarness({ seed: 304 });
    h.emu.installSheetCarriers({ dropsMissingFields: true });
    pageId = h.emu.createPage("Drops");
    h.emu.setPlayerPage(pageId);
    charId = h.emu.createCharacter("Brie", {}, "player-1");
    const id = makePc("Brie", charId);
    await expect(h.callTool("update_token_hp", { tokenId: id, setHp: 3 })).rejects.toThrow(/reported success/);
    expect(await sheet("hp")).toBeNull();
    // An empty field must not pass as a zero that landed.
    await expect(h.callTool("update_token_hp", { tokenId: id, setHp: 0 })).rejects.toThrow(/reported success/);
  });

  it("fails loudly on a sandbox with no sheet carriers rather than falling back to tracked", async () => {
    const old = setupHarness({ seed: 301 });
    const page = old.emu.createPage("Old");
    old.emu.setPlayerPage(page);
    const char = old.emu.createCharacter("Old PC", { hp: 10 }, "player-1");
    const t = old.emu.createToken({ pageid: page, name: "Old PC", controlledby: "player-1", represents: char, layer: "objects" });
    await expect(old.callTool("update_token_hp", { tokenId: t.id, damage: 1 })).rejects.toThrow(/does not exist in this Mod sandbox/);
    expect(String(old.emu.tokenProps(t.id).gmnotes ?? "")).not.toContain("%%PCHP");
    old.teardown();
  });
});

describe("Beacon sheet holding HP in a computed property", () => {
  beforeEach(() => {
    h.teardown();
    h = setupHarness({ seed: 302 });
    h.emu.installSheetCarriers({ sheetName: "D&D 5E 2024", computed: { hp: { current: 31, max: 44 } } });
    pageId = h.emu.createPage("Beacon");
    h.emu.setPlayerPage(pageId);
    charId = h.emu.createCharacter("Brie", {}, "player-1");
  });

  it("reaches it through the same carrier", async () => {
    const id = makePc("Brie", charId);
    const { text } = await h.callTool("update_token_hp", { tokenId: id, damage: 6 });
    expect(await sheet("hp")).toBe(25);
    expect(text).toContain("25/44 (sheet)");
  });

  it("reports a read-only computed property as a refusal", async () => {
    h.teardown();
    h = setupHarness({ seed: 303 });
    h.emu.installSheetCarriers({ computed: { hp: { current: 31, max: 44 } }, readOnlyComputed: ["hp"] });
    pageId = h.emu.createPage("Beacon RO");
    h.emu.setPlayerPage(pageId);
    charId = h.emu.createCharacter("Brie", {}, "player-1");
    const id = makePc("Brie", charId);
    await expect(h.callTool("update_token_hp", { tokenId: id, damage: 6 })).rejects.toThrow(/refused the write/);
    expect(await sheet("hp")).toBe(31);
  });
});

describe("the other paths that write PC HP", () => {
  it("update_hp_many writes sheets for PCs and bar1 for NPCs, reporting a failure per target", async () => {
    const good = makePc("Brie", charId);
    const bad = makePc("Unlinked", "");
    h.emu.createToken({ pageid: pageId, name: "Goblin", controlledby: "", bar1_value: 10, bar1_max: 10, layer: "objects", left: 140, top: 70 });
    const { text } = await h.callTool("update_hp_many", { names: ["Brie", "Unlinked", "Goblin"], damage: 4 });
    expect(await sheet("hp")).toBe(26);
    expect(text).toContain("26/44 (sheet)");
    expect(text).toContain("Goblin: 6/10");
    expect(text).toMatch(/Unlinked: FAILED/);
    expect(Number(props(good).bar1_value)).toBe(7);
    expect(Number(props(bad).bar1_value)).toBe(7);
    expect(h.relayLog).not.toContain("adjustPcHp");
  });

  it("resolve_aoe healing reaches a sheet PC and reports the sheet's max", async () => {
    makePc("Brie", charId);
    const { text } = await h.callTool("resolve_aoe", { label: "Mass Cure", targetNames: ["Brie"], healing: true, damage: 5 });
    expect(await sheet("hp")).toBe(35);
    expect(text).toContain("35/44");
  });

  it("revive_token sets HP on the sheet", async () => {
    const id = makePc("Brie", charId);
    await h.callTool("kill_token", { tokenId: id });
    const { text } = await h.callTool("revive_token", { tokenId: id, hp: 12, initiative: 10 });
    expect(await sheet("hp")).toBe(12);
    expect(text).toContain("(sheet)");
    expect(String(props(id).layer)).toBe("objects");
  });

  it("a sidekick stays on bar1 in a sheet campaign", async () => {
    characters.setSidekick("Tua", true);
    const id = makePc("Tua", charId);
    await h.callTool("update_token_hp", { tokenId: id, damage: 2 });
    expect(Number(props(id).bar1_value)).toBe(5);
    expect(await sheet("hp")).toBe(30);
    characters.setSidekick("Tua", false);
  });
});

describe("the setting", () => {
  it("tracked remains the behaviour when the mode is off", async () => {
    campaigns.setPcSheetHp(null);
    const id = makePc("Brie", charId);
    const { text } = await h.callTool("update_token_hp", { tokenId: id, damage: 3 });
    expect(text).toContain("(tracked)");
    expect(await sheet("hp")).toBe(30);
    expect(Number(props(id).bar1_value)).toBe(7);
  });

  it("set_pc_hp_source switches both ways and defaults the field to hp", async () => {
    await h.callTool("set_pc_hp_source", { source: "tracked" });
    expect(campaigns.getPcSheetHp()).toBeNull();
    await h.callTool("set_pc_hp_source", { source: "sheet" });
    expect(campaigns.getPcSheetHp()).toEqual({ attribute: "hp" });
  });

  it("list_campaigns says which source a campaign uses", async () => {
    const { json } = await h.callTool("list_campaigns");
    const row = (json as { slug: string; pcHpSource: string }[]).find((c) => c.slug === "sheet-table");
    expect(row?.pcHpSource).toBe("sheet");
  });

  it("re-registering a campaign keeps the setting", () => {
    campaigns.registerCampaign("Sheet Table", "99001", "new notes");
    expect(campaigns.getPcSheetHp()).toEqual({ attribute: "hp" });
  });

  it("refuses an attribute on tracked", async () => {
    await expect(h.callTool("set_pc_hp_source", { source: "tracked", attribute: "hp" })).rejects.toThrow(/only applies/);
  });
});

describe("applyHpOp", () => {
  it("matches the other HP paths' clamps", () => {
    expect(applyHpOp({ damage: 5 }, 3, 10)).toBe(0);
    expect(applyHpOp({ heal: 5 }, 8, 10)).toBe(10);
    expect(applyHpOp({ heal: 5 }, 8, 0)).toBe(13);
    expect(applyHpOp({ setHp: 99 }, 8, 10)).toBe(99);
  });
});
