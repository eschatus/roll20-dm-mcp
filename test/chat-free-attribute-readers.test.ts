// #255: get_character_attribute and resolve_aoe's save bonuses read over the same chat-free RTDB
// path as read_character_attributes (#253). The relay's getCharacterAttributes echoes through
// Roll20 chat, which is what disabled the sandbox on relay 2.6.2, so neither may reach for it, even
// on failure.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupHarness, CHAR_ATTRIB_READ, type Harness } from "./harness.js";

const ROLLBASE = "@{wtype}&{template:npcfullatk} {{r1=[[@{d20}+(@{attack_tohit}+0)]]}}";

let h: Harness;
let charId: string;

beforeAll(() => {
  h = setupHarness({ seed: 255 });
  const pageId = h.emu.createPage("Attr Page");
  h.emu.setPlayerPage(pageId);
  charId = h.emu.createCharacter("Save Brute", { npc_con_save: 7, rollbase: ROLLBASE });
  h.emu.createObj("attribute", { characterid: charId, name: "hp", current: 16, max: 22 });
  h.emu.createToken({ pageid: pageId, name: "Save Brute", represents: charId, bar1_value: 40, bar1_max: 40, left: 700, top: 700 });
  h.emu.createToken({ pageid: pageId, name: "Blast Centre", left: 770, top: 700 });
});

afterAll(() => h.teardown());

afterEach(() => {
  h.clearRelayFailures();
  h.clearRelayLog();
});

describe("get_character_attribute reads RTDB directly (#255)", () => {
  it("returns a rollbase-style value intact without touching the relay", async () => {
    const { json } = await h.callTool("get_character_attribute", { charSheetId: charId, attributeName: "rollbase" });
    expect(json).toMatchObject({ attribute: "rollbase", current: ROLLBASE, max: null });
    expect(h.relayLog).toEqual([CHAR_ATTRIB_READ]);
  });

  it("keeps current and max apart, and reports an absent attribute as null", async () => {
    const hp = await h.callTool("get_character_attribute", { charSheetId: charId, attributeName: "hp" });
    expect(hp.json).toMatchObject({ current: 16, max: 22 });
    const none = await h.callTool("get_character_attribute", { charSheetId: charId, attributeName: "nope" });
    expect(none.json).toMatchObject({ current: null, max: null });
  });

  it("fails loudly with no fallback to the relay's chat echo", async () => {
    h.failRelayAction(CHAR_ATTRIB_READ, "permission_denied");
    await expect(h.callTool("get_character_attribute", { charSheetId: charId, attributeName: "hp" }))
      .rejects.toThrow(/RTDB read of char-attribs.*permission_denied/);
    expect(h.relayLog).not.toContain("getCharacterAttributes");
  });
});

describe("resolve_aoe save bonuses read RTDB directly (#255)", () => {
  it("rolls with the sheet's save bonus and never asks the relay for attributes", async () => {
    const { text } = await h.callTool("resolve_aoe", {
      label: "Cloudkill", centerTokenName: "Blast Centre", radiusFeet: 15, draw: "none",
      saveAbility: "constitution", saveDc: 14, damage: 1,
    });
    expect(text.split("\n").find((l) => l.startsWith("Save Brute:"))).not.toMatch(/flat d20/);
    expect(h.relayLog).toContain(CHAR_ATTRIB_READ);
    expect(h.relayLog).not.toContain("getCharacterAttributes");
  });
});
