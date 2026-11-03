// #246: set_initiatives mirrors totals rolled elsewhere (for Echoes of Orcus, the SR6 engine) into
// the turn order. Roll20 must never roll, and a write must update rather than duplicate.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";

interface Row { id: string; name: string; pr: string }

let h: Harness;
const ids: Record<string, string> = {};

const turnOrder = () => h.emu.relay<{ id: string; pr: string }[]>({ action: "getTurnOrder" });
const write = async (entries: unknown[]) => {
  const { json } = await h.callTool("set_initiatives", { entries });
  return (json as { turnorder: Row[] }).turnorder;
};

beforeEach(() => {
  h?.teardown();
  h = setupHarness({ seed: 246 });
  const pageId = h.emu.createPage("Initiative Page");
  h.emu.setPlayerPage(pageId);
  for (const name of ["Adept", "Barghest", "Combat Mage"]) {
    ids[name] = h.emu.createToken({ pageid: pageId, name, controlledby: "" }).id;
  }
  ids.Runner = h.emu.createToken({ pageid: pageId, name: "Runner", controlledby: "player-001" }).id;
});

afterAll(() => h.teardown());

describe("set_initiatives (#246)", () => {
  it("writes the totals as given, sorted highest first, for PCs and NPCs alike, with no dice", async () => {
    const rows = await write([
      { characterName: "Adept", initiative: 12 },
      { characterName: "Runner", initiative: 21 },
      { tokenId: ids.Barghest, initiative: 9 },
    ]);
    expect(rows.map((r) => [r.name, r.pr])).toEqual([["Runner", "21"], ["Adept", "12"], ["Barghest", "9"]]);
    expect(h.relayLog).toEqual(["getTokens", "mergeTurnOrder"]);
  });

  it("sorts numerically, so 10 stays above 9", async () => {
    const rows = await write([{ characterName: "Adept", initiative: 9 }, { characterName: "Barghest", initiative: 10 }]);
    expect(rows.map((r) => r.name)).toEqual(["Barghest", "Adept"]);
  });

  it("updates an existing entry instead of duplicating it, and keeps everyone else", async () => {
    await write([{ characterName: "Adept", initiative: 12 }, { characterName: "Runner", initiative: 21 }]);
    await write([{ characterName: "Adept", initiative: 30 }]);
    expect(turnOrder().map((e) => [e.id, e.pr])).toEqual([[ids.Adept, "30"], [ids.Runner, "21"]]);
  });

  it("writes nothing when any name fails to resolve", async () => {
    await expect(h.callTool("set_initiatives", {
      entries: [{ characterName: "Adept", initiative: 12 }, { characterName: "Dragon", initiative: 30 }],
    })).rejects.toThrow(/Dragon/);
    expect(h.relayLog).not.toContain("mergeTurnOrder");
  });

  it("refuses a stale or other-page tokenId instead of writing a phantom row", async () => {
    await expect(h.callTool("set_initiatives", {
      entries: [{ characterName: "Adept", initiative: 12 }, { tokenId: "-gone", initiative: 30 }],
    })).rejects.toThrow(/entries\[1\]: token -gone is not on the current page/);
    expect(h.relayLog).not.toContain("mergeTurnOrder");
  });

  it("treats an empty tokenId as absent", async () => {
    const rows = await write([{ tokenId: "", characterName: "Adept", initiative: 12 }]);
    expect(rows.map((r) => r.name)).toEqual(["Adept"]);
  });

  it("refuses the same token twice, and an entry with no target", async () => {
    await expect(h.callTool("set_initiatives", {
      entries: [{ characterName: "Adept", initiative: 12 }, { tokenId: ids.Adept, initiative: 30 }],
    })).rejects.toThrow(/appears twice/);
    await expect(h.callTool("set_initiatives", { entries: [{ initiative: 12 }] }))
      .rejects.toThrow(/entries\[0\]: provide tokenId or characterName/);
    expect(h.relayLog).not.toContain("mergeTurnOrder");
  });
});
