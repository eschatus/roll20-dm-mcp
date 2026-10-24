// ─────────────────────────────────────────────────────────────────────────────
// #239 — roll_initiative's empty-board message names the filter that emptied it.
//
// Live (2026-10-06): names ["Zeno","Vampire Spawn","Calisandre Gravebloom","Dante Van Hexen"]
// came back "No tokens found on token layer" although three of them WERE on the token layer.
// npcOnly (default true) removed the PCs and the layer filter removed the gmlayer NPC; the
// message blamed the layer, so the gem retried the same names twice. The message must say
// which filter removed the matches. Message-only: no behaviour change.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";

let h: Harness;

beforeAll(() => {
  h = setupHarness({ seed: 239 });
  const pageId = h.emu.createPage("Diagnosis Page");
  h.emu.setPlayerPage(pageId);
  for (const [name, x] of [["Zeno", 140], ["Calisandre Gravebloom", 210], ["Dante Van Hexen", 280]] as const) {
    h.emu.createToken({ pageid: pageId, name, controlledby: "player-001", layer: "objects", left: x, top: 140 });
  }
  for (const x of [700, 770]) {
    h.emu.createToken({ pageid: pageId, name: "Vampire Spawn", controlledby: "", layer: "gmlayer", left: x, top: 700 });
  }
});

afterAll(() => h.teardown());

describe("roll_initiative empty-board diagnosis (#239)", () => {
  it("names the PC filter and the off-layer NPCs instead of blaming the token layer", async () => {
    const { text } = await h.callTool("roll_initiative", {
      names: ["Zeno", "Vampire Spawn", "Calisandre Gravebloom", "Dante Van Hexen"],
      publicRoll: false,
    });
    expect(text).not.toMatch(/No tokens found on token layer/);
    expect(text).toMatch(/Zeno/);
    expect(text).toMatch(/npcOnly/);
    expect(text).toMatch(/Vampire Spawn ×2/);
    expect(text).toMatch(/gmlayer/);
  });

  it("says plainly when a name matches no token on the page", async () => {
    const { text } = await h.callTool("roll_initiative", { names: ["Beholder"], publicRoll: false });
    expect(text).toMatch(/No token on this page matches: Beholder/);
  });

  it("lists names that matched nothing alongside the ones that were filtered", async () => {
    const { text } = await h.callTool("roll_initiative", { names: ["Zeno", "Beholder"], publicRoll: false });
    expect(text).toMatch(/Zeno/);
    expect(text).toMatch(/npcOnly/);
    expect(text).toMatch(/Beholder/);
  });
});
