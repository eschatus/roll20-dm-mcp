// #258: find_tokens_in_range only took a token id, and all 20 live calls in the gem's event log
// passed a name. resolve_aoe already takes centerTokenName; the radius tool now does too.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";

let h: Harness;
let pageId: string;
let otherPageId: string;
let casterId: string;

const rangeNames = (json: unknown) => (json as { name: string }[]).map((t) => t.name);

beforeAll(() => {
  h = setupHarness({ seed: 258 });
  pageId = h.emu.createPage("Range Page");
  otherPageId = h.emu.createPage("Other Page");
  h.emu.setPlayerPage(pageId);
  casterId = h.emu.createToken({ pageid: pageId, name: "Brie Mossfrond", controlledby: "", left: 700, top: 700 }).id;
  h.emu.createToken({ pageid: pageId, name: "Close Ogre", controlledby: "", left: 770, top: 700 });
  h.emu.createToken({ pageid: pageId, name: "Far Ogre", controlledby: "", left: 3500, top: 700 });
  h.emu.createToken({ pageid: pageId, name: "Twin", controlledby: "", left: 140, top: 140 });
  h.emu.createToken({ pageid: pageId, name: "Twin", controlledby: "", left: 210, top: 140 });
  h.emu.createToken({ pageid: otherPageId, name: "Off Page Seer", controlledby: "", left: 700, top: 700 });
  h.emu.createToken({ pageid: otherPageId, name: "Off Page Rat", controlledby: "", left: 770, top: 700 });
});

afterAll(() => h.teardown());

describe("find_tokens_in_range center (#258)", () => {
  it("resolves centerTokenName and returns the same answer as the id", async () => {
    const byName = await h.callTool("find_tokens_in_range", { centerTokenName: "Brie Mossfrond", radiusFeet: 10 });
    const byId = await h.callTool("find_tokens_in_range", { centerTokenId: casterId, radiusFeet: 10 });
    expect(rangeNames(byName.json)).toContain("Close Ogre");
    expect(rangeNames(byName.json)).not.toContain("Far Ogre");
    expect(byName.json).toEqual(byId.json);
  });

  it("resolves the name on the page being searched, not the player page", async () => {
    const { json } = await h.callTool("find_tokens_in_range", {
      centerTokenName: "Off Page Seer", radiusFeet: 10, pageId: otherPageId,
    });
    expect(rangeNames(json)).toContain("Off Page Rat");
  });

  it("refuses an ambiguous center instead of picking the first match", async () => {
    await expect(h.callTool("find_tokens_in_range", { centerTokenName: "Twin", radiusFeet: 10 }))
      .rejects.toThrow(/Ambiguous target "Twin"/);
  });

  it("requires a center", async () => {
    await expect(h.callTool("find_tokens_in_range", { radiusFeet: 10 }))
      .rejects.toThrow(/Provide centerTokenName or centerTokenId/);
  });

  it("a name passed as centerTokenId is refused and points at centerTokenName", async () => {
    await expect(h.callTool("find_tokens_in_range", { centerTokenId: "Brie Mossfrond", radiusFeet: 10 }))
      .rejects.toThrow(/Center token not found.*pass a name as centerTokenName/);
  });
});
