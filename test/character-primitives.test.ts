// ─────────────────────────────────────────────────────────────────────────────
// Character sheet primitives (src/tools/character.ts, relay 2.12.0): the journal, a character's own
// fields, repeating rows, attribute deletion, abilities, and token links. Runs the real tools
// against the real relay in the emulator. The live half is src/recon/pc-sheet-hp-it.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import { groupRepeatingRows, newRowId, parseRepeatingName } from "../src/tools/character.js";
import { __setDefaultTokenTestStore } from "../src/bridge/default-token.js";

let h: Harness;
let charId: string;

const attrs = () => (h.emu.charAttribRecords(charId) ?? {}) as Record<string, { name: string; current?: unknown; max?: unknown }>;
const attrNames = () => Object.values(attrs()).map((a) => a.name);

beforeEach(() => {
  h = setupHarness({ seed: 400 });
  const page = h.emu.createPage("Sheets");
  h.emu.setPlayerPage(page);
  charId = h.emu.createCharacter("Brie Mossfrond", { hp: 30 }, "player-1");
});

afterEach(() => h.teardown());

describe("row ids and names", () => {
  it("mints Roll20-shaped ids with no underscore", () => {
    for (let i = 0; i < 200; i++) expect(newRowId()).toMatch(/^-[A-Za-z0-9]{19}$/);
  });

  it("splits a plain id", () => {
    expect(parseRepeatingName("repeating_gear_abc_name", "gear")).toEqual({ rowId: "abc", field: "name" });
  });

  it("keeps a Roll20 id containing an underscore whole", () => {
    expect(parseRepeatingName("repeating_gear_-Mabc_defghijklmnopq_item_name", "gear"))
      .toEqual({ rowId: "-Mabc_defghijklmnopq", field: "item_name" });
  });

  it("does not read another section, or a section with a longer name", () => {
    expect(parseRepeatingName("repeating_gearx_abc_name", "gear")).toBeNull();
    expect(parseRepeatingName("hp", "gear")).toBeNull();
    expect(parseRepeatingName("repeating_gear_abc", "gear")).toBeNull();
  });

  it("groups fields under their rows", () => {
    expect(groupRepeatingRows({
      repeating_gear_a_name: "Rope", repeating_gear_a_weight: { current: 5, max: 10 }, repeating_gear_b_name: "Lamp", hp: 1,
    }, "gear")).toEqual({ a: { name: "Rope", weight: { current: 5, max: 10 } }, b: { name: "Lamp" } });
  });
});

describe("the journal", () => {
  it("list_characters filters, and hides archived unless asked", async () => {
    const old = h.emu.createCharacter("Old Friend", {});
    await h.callTool("set_character_props", { charId: old, archived: true });
    const { json } = await h.callTool("list_characters", {});
    const names = (json as { characters: { name: string }[] }).characters.map((c) => c.name);
    expect(names).toContain("Brie Mossfrond");
    expect(names).not.toContain("Old Friend");
    const all = await h.callTool("list_characters", { includeArchived: true, nameContains: "friend" });
    expect((all.json as { characters: unknown[] }).characters).toHaveLength(1);
  });

  it("an unregistered character works by exact name across the older tools", async () => {
    const { json } = await h.callTool("read_character_attributes", { characterName: "brie mossfrond" });
    expect((json as { charSheetId: string }).charSheetId).toBe(charId);
  });

  it("refuses to choose between two characters of one name, and names both", async () => {
    const twin = h.emu.createCharacter("Brie Mossfrond", {});
    await expect(h.callTool("get_character", { characterName: "Brie Mossfrond" })).rejects.toThrow(new RegExp(twin));
  });

  it("refuses a name in neither place", async () => {
    await expect(h.callTool("get_character", { characterName: "Nobody" })).rejects.toThrow(/not in the journal/);
  });
});

describe("get_character", () => {
  it("reads the blob fields through their callbacks", async () => {
    await h.callTool("set_character_props", { charId, bio: "<p>Born @{here} [[1d6]]</p>", gmnotes: "secret" });
    const { json } = await h.callTool("get_character", { charSheetId: charId });
    expect(json).toMatchObject({ id: charId, name: "Brie Mossfrond", bio: "<p>Born @{here} [[1d6]]</p>", gmnotes: "secret", controlledby: "player-1" });
  });

  it("refuses an unknown id", async () => {
    await expect(h.callTool("get_character", { charSheetId: "-nope" })).rejects.toThrow(/Character not found/);
  });
});

describe("repeating rows", () => {
  it("adds a row, reads it back, updates it, and deletes only it", async () => {
    const add = await h.callTool("set_repeating_row", { charSheetId: charId, section: "inventory", fields: { name: "Rope", qty: 2 } });
    const { rowId, added } = add.json as { rowId: string; added: boolean };
    expect(added).toBe(true);
    expect(rowId).toMatch(/^-[A-Za-z0-9]{19}$/);

    const other = await h.callTool("set_repeating_row", { charSheetId: charId, section: "inventory", fields: { name: "Lamp" } });
    await h.callTool("set_repeating_row", { charSheetId: charId, section: "inventory", rowId, fields: { qty: 5 } });

    const read = await h.callTool("get_repeating_section", { charSheetId: charId, section: "inventory" });
    const rows = (read.json as { rows: Record<string, Record<string, unknown>> }).rows;
    expect(rows[rowId]).toEqual({ name: "Rope", qty: 5 });

    const del = await h.callTool("delete_repeating_row", { charSheetId: charId, section: "inventory", rowId });
    expect((del.json as { removed: string[] }).removed).toHaveLength(2);
    expect(attrNames().some((n) => n.includes(rowId))).toBe(false);
    expect(attrNames().some((n) => n.includes((other.json as { rowId: string }).rowId))).toBe(true);
    expect(attrNames()).toContain("hp");
  });

  it("returns macro fields literally and never touches the relay to read", async () => {
    await h.callTool("set_repeating_row", { charSheetId: charId, section: "npcaction", rowId: "row1", fields: { rollbase: "@{wtype}[[1d20]]" } });
    h.clearRelayLog();
    const { json } = await h.callTool("get_repeating_section", { charSheetId: charId, section: "npcaction" });
    expect((json as { rows: Record<string, { rollbase: string }> }).rows.row1.rollbase).toBe("@{wtype}[[1d20]]");
    expect(h.relayLog).not.toContain("getCharacterAttributes");
  });

  it("deleting a row that isn't there is a failure", async () => {
    const { isError } = await h.callTool("delete_repeating_row", { charSheetId: charId, section: "inventory", rowId: "ghost" });
    expect(isError).toBe(true);
  });

  it("the relay won't delete by a prefix that isn't a row", async () => {
    await expect(h.emu.relayAsync({ action: "deleteAttributes", charId, prefix: "h" })).rejects.toThrow(/must be repeating_/);
    expect(attrNames()).toContain("hp");
  });

  it("reports a Beacon-refused row write as a failure", async () => {
    h.emu.installSheetCarriers({ computed: { repeating_gear_r1_name: "x" } });
    const { isError, text } = await h.callTool("set_repeating_row", { charSheetId: charId, section: "gear", rowId: "r1", fields: { name: "y" } });
    expect(isError).toBe(true);
    expect(text).toContain("partial");
  });
});

describe("delete_character_attributes", () => {
  it("deletes what exists and lists what doesn't", async () => {
    const { json } = await h.callTool("delete_character_attributes", { charSheetId: charId, names: ["hp", "nope"] });
    expect(json).toMatchObject({ removed: ["hp"], missing: ["nope"] });
    expect(attrNames()).not.toContain("hp");
  });
});

describe("abilities", () => {
  it("creates, lists literally, updates by name, renames by id, and deletes", async () => {
    const macro = "/me @{selected|token_name} rolls [[1d20]]";
    const made = await h.callTool("set_character_ability", { charSheetId: charId, name: "Strike", action: macro, isTokenAction: true });
    const { id, created } = made.json as { id: string; created: boolean };
    expect(created).toBe(true);

    const again = await h.callTool("set_character_ability", { charSheetId: charId, name: "Strike", description: "A hit" });
    expect(again.json).toMatchObject({ id, created: false });

    await h.callTool("set_character_ability", { charSheetId: charId, abilityId: id, name: "Smite" });

    const { json } = await h.callTool("list_character_abilities", { charSheetId: charId });
    expect((json as { abilities: unknown[] }).abilities).toEqual([
      { id, name: "Smite", description: "A hit", action: macro, istokenaction: true },
    ]);

    await h.callTool("delete_character_ability", { abilityId: id });
    const after = await h.callTool("list_character_abilities", { charSheetId: charId });
    expect((after.json as { abilities: unknown[] }).abilities).toEqual([]);
  });

  it("writing a macro sends nothing to chat but its result", async () => {
    const before = h.emu.chatLog.length;
    await h.callTool("set_character_ability", { charSheetId: charId, name: "Strike", action: "[[1d20]]" });
    for (const m of h.emu.chatLog.slice(before)) expect(m.content).not.toContain("[[");
  });

  it("refuses an ability on another character", async () => {
    const other = h.emu.createCharacter("Other", {});
    const made = await h.callTool("set_character_ability", { charSheetId: other, name: "Theirs", action: "x" });
    const { id } = made.json as { id: string };
    await expect(h.callTool("set_character_ability", { charSheetId: charId, abilityId: id, action: "y" })).rejects.toThrow(/not found on character/);
  });

  it("refuses a name that matches two abilities", async () => {
    await h.emu.relayAsync({ action: "setAbility", charId, name: "Dup", abilityAction: "a" });
    // Roll20 allows two abilities of one name; the relay never makes one, so plant it.
    (h.emu as unknown as { createObj(t: string, p: object): unknown }).createObj("ability", { characterid: charId, name: "Dup", action: "b" });
    await expect(h.callTool("set_character_ability", { charSheetId: charId, name: "Dup", action: "c" })).rejects.toThrow(/pass abilityId/);
  });
});

describe("tokens", () => {
  it("link_token_to_character sets represents and links bars with the attribute's values", async () => {
    await h.callTool("set_character_attribute", { charSheetId: charId, attributeName: "hp", value: 30, max: 44 });
    const page = h.emu.campaignModel.get("playerpageid") as string;
    const t = h.emu.createToken({ pageid: page, name: "Brie" });
    await h.callTool("link_token_to_character", { tokenId: t.id, charSheetId: charId, bars: [{ bar: 1, attribute: "hp" }] });
    const attr = Object.entries(attrs()).find(([, a]) => a.name === "hp")!;
    expect(t.get("represents")).toBe(charId);
    expect(t.get("bar1_link")).toBe(attr[0]);
    expect(Number(t.get("bar1_value"))).toBe(30);
    expect(Number(t.get("bar1_max"))).toBe(44);
  });

  it("a missing attribute changes nothing", async () => {
    const page = h.emu.campaignModel.get("playerpageid") as string;
    const t = h.emu.createToken({ pageid: page, name: "Brie" });
    await expect(h.callTool("link_token_to_character", {
      tokenId: t.id, charSheetId: charId, bars: [{ bar: 1, attribute: "hp" }, { bar: 2, attribute: "nope" }],
    })).rejects.toThrow(/No attribute 'nope'/);
    expect(t.get("represents")).toBe("");
    expect(t.get("bar1_link")).toBe("");
  });

  it("moving a token to another character unlinks the bars not relinked", async () => {
    await h.callTool("set_character_attribute", { charSheetId: charId, attributeName: "mana", value: 5 });
    const other = h.emu.createCharacter("Noor", { hp: 9 }, "player-1");
    const page = h.emu.campaignModel.get("playerpageid") as string;
    const t = h.emu.createToken({ pageid: page, name: "Brie" });
    await h.callTool("link_token_to_character", {
      tokenId: t.id, charSheetId: charId, bars: [{ bar: 1, attribute: "hp" }, { bar: 2, attribute: "mana" }],
    });
    const { json } = await h.callTool("link_token_to_character", { tokenId: t.id, charSheetId: other, bars: [{ bar: 1, attribute: "hp" }] });
    expect(json).toMatchObject({ unlinked: [2] });
    expect(t.get("bar2_link")).toBe("");
    const noorHp = Object.values(h.emu.charAttribRecords(other)!)[0];
    expect(t.get("bar1_link")).toBe(noorHp.id);
  });

  it("relinking on the same character leaves its other bars alone", async () => {
    await h.callTool("set_character_attribute", { charSheetId: charId, attributeName: "mana", value: 5 });
    const page = h.emu.campaignModel.get("playerpageid") as string;
    const t = h.emu.createToken({ pageid: page, name: "Brie" });
    await h.callTool("link_token_to_character", { tokenId: t.id, charSheetId: charId, bars: [{ bar: 2, attribute: "mana" }] });
    const linked = t.get("bar2_link");
    await h.callTool("link_token_to_character", { tokenId: t.id, charSheetId: charId, bars: [{ bar: 1, attribute: "hp" }] });
    expect(t.get("bar2_link")).toBe(linked);
  });

  it("keeps a by-name sheetattr link when the character changes", async () => {
    const other = h.emu.createCharacter("Noor", {}, "player-1");
    const page = h.emu.campaignModel.get("playerpageid") as string;
    const t = h.emu.createToken({ pageid: page, name: "Brie", represents: charId, bar3_link: "sheetattr_hp" });
    await h.callTool("link_token_to_character", { tokenId: t.id, charSheetId: other });
    expect(t.get("bar3_link")).toBe("sheetattr_hp");
  });

  it("set_default_token writes the blob and timestamp nodes Roll20 reads", async () => {
    const page = h.emu.campaignModel.get("playerpageid") as string;
    const t = h.emu.createToken({ pageid: page, name: "Brie", represents: charId });
    await h.callTool("set_default_token", { tokenId: t.id });
    const saved = h.defaultTokens.get(charId)!;
    expect(JSON.parse(saved.blob)).toMatchObject({ name: "Brie", represents: charId });
    expect(saved.stamp).toBeGreaterThan(0);
  });

  it("set_default_token fails when the blob doesn't hold what was written", async () => {
    __setDefaultTokenTestStore({ write: async () => {}, read: async () => "" });
    const page = h.emu.campaignModel.get("playerpageid") as string;
    const t = h.emu.createToken({ pageid: page, name: "Brie", represents: charId });
    await expect(h.callTool("set_default_token", { tokenId: t.id })).rejects.toThrow(/did not land/);
  });

  it("set_default_token refuses a relay too old to return the token", async () => {
    h.stubRelayAction("setDefaultToken", { charId, character: "Brie", fields: 3 });
    const page = h.emu.campaignModel.get("playerpageid") as string;
    const t = h.emu.createToken({ pageid: page, name: "Brie", represents: charId });
    await expect(h.callTool("set_default_token", { tokenId: t.id })).rejects.toThrow(/Re-paste relay/);
    expect(h.defaultTokens.size).toBe(0);
  });
});

describe("set_sheet_item read-back", () => {
  it("reports a write the sheet dropped", async () => {
    h.emu.installSheetCarriers({ dropsMissingFields: true });
    const { isError, json } = await h.callTool("set_sheet_item", { charSheetId: charId, attributes: { nothing_here: 5 } });
    expect(isError).toBe(true);
    expect(json).toMatchObject({ notLanded: [{ name: "nothing_here", sent: 5, holds: null }] });
  });

  it("accepts current and max that landed, whatever their type", async () => {
    h.emu.installSheetCarriers({ dropsMissingFields: true });
    const { isError } = await h.callTool("set_sheet_item", { charSheetId: charId, attributes: { hp: { current: 12, max: "40" } } });
    expect(isError).toBe(false);
  });
});

describe("set_character_attribute withWorker", () => {
  it("writes through setAttrs, past the Beacon refusal", async () => {
    h.teardown();
    h = setupHarness({ seed: 401 });
    h.emu.installSheetCarriers({ sheetWriteShim: true, computed: { hp: { current: 1 } } } as never);
    charId = h.emu.createCharacter("Brie Mossfrond", {}, "player-1");
    await h.callTool("set_character_attribute", { charSheetId: charId, attributeName: "hp", value: 30, withWorker: true }).catch((e) => e);
    expect(h.relayLog).toContain("setAttrs");
  });
});
