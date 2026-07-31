// ─────────────────────────────────────────────────────────────────────────────
// Issue #141 — bloodied/wounded threshold + auto-death automation, server-side.
//
// Golden-suite evidence: under compound turns the model reliably applies damage
// but DROPS the wounded-threshold marker and sometimes the auto-death at 0. The
// threshold rule is pure arithmetic, so it now lives in the HP-write path itself
// (mod-scripts/ai-relay.js's setTokenBar chokepoint — see relay-actions.test.ts
// for the relay-level coverage) rather than the model's working memory.
//
// This suite drives the REAL update_token_hp / update_hp_many / resolve_aoe MCP
// handlers against the emulator (mod-scripts/ai-relay.js in a vm sandbox), same
// pattern as sidekick-routing.test.ts, proving the automation fires no matter
// which of the three write paths is used, is SYMMETRIC (comes off on healing),
// never fires for PCs, and doesn't fight an explicit DM override in the same call.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";

let h: Harness;

const bar = (id: string) => Number(h.emu.tokenProps(id).bar1_value);
const layer = (id: string) => String(h.emu.tokenProps(id).layer ?? "");
const markers = (id: string) => String(h.emu.tokenProps(id).statusmarkers ?? "");

function tokenId(pageId: string, name: string): string {
  const tokens = h.emu.relay<Array<{ id: string; name: string }>>({ action: "getTokens", pageId });
  const tok = tokens.find((t) => t.name === name);
  if (!tok) throw new Error(`Token not found in emulator: ${name}`);
  return tok.id;
}

let pageId: string;

beforeAll(() => {
  h = setupHarness({ seed: 141 });
  pageId = h.emu.createPage("Threshold Automation Tests");
  h.emu.setPlayerPage(pageId);

  h.emu.createToken({ pageid: pageId, name: "Priest B", controlledby: "", bar1_value: 33, bar1_max: 33 });
  h.emu.createToken({ pageid: pageId, name: "Priest C", controlledby: "", bar1_value: 33, bar1_max: 33 });
  h.emu.createToken({ pageid: pageId, name: "Ogre", controlledby: "", bar1_value: 20, bar1_max: 20 });
  h.emu.createToken({ pageid: pageId, name: "Skeleton A", controlledby: "", bar1_value: 12, bar1_max: 12 });
  h.emu.createToken({ pageid: pageId, name: "Skeleton B", controlledby: "", bar1_value: 12, bar1_max: 12 });
  h.emu.createToken({ pageid: pageId, name: "Fighter", controlledby: "player-1", bar1_value: 30, bar1_max: 30 });
});

afterAll(() => h.teardown());

describe("update_token_hp — threshold automation", () => {
  it("crossing to at-or-below half applies Wounded and reports it, unprompted", async () => {
    const id = tokenId(pageId, "Priest B");
    const { text } = await h.callTool("update_token_hp", { characterName: "Priest B", damage: 28 });

    expect(bar(id)).toBe(5);
    expect(markers(id)).toContain("Wounded::4444333");
    expect(text).toMatch(/5\/33/);
    expect(text).toMatch(/wounded/i);
  });

  it("healing back above half REMOVES the Wounded marker (symmetric)", async () => {
    const id = tokenId(pageId, "Priest B"); // currently 5/33, wounded
    const { text } = await h.callTool("update_token_hp", { characterName: "Priest B", heal: 20 });

    expect(bar(id)).toBe(25);
    expect(markers(id)).not.toMatch(/Wounded/);
    expect(text).not.toMatch(/wounded/i);
  });

  it("damage to exactly 0 auto-marks dead and moves the token to the map layer", async () => {
    const id = tokenId(pageId, "Ogre");
    expect(layer(id)).not.toBe("map");

    const { text } = await h.callTool("update_token_hp", { characterName: "Ogre", damage: 20 });

    expect(bar(id)).toBe(0);
    expect(layer(id)).toBe("map");
    expect(markers(id)).toMatch(/dead/); // built-in dead marker (renders in every campaign)
    expect(text).toMatch(/0\/20/);
    expect(text).toMatch(/DEAD/);
  });

  it("PCs get NEITHER automation — tracked HP has no bar1 marker to touch", async () => {
    const id = tokenId(pageId, "Fighter");
    const { text } = await h.callTool("update_token_hp", { characterName: "Fighter", damage: 29 }); // 30 -> 1, tracked

    expect(bar(id)).toBe(30); // bar1 untouched — Beyond20 owns it
    expect(markers(id)).not.toMatch(/Wounded|dead/);
    expect(text).toMatch(/\(tracked\)/);
    expect(text).not.toMatch(/wounded|DEAD/i);
  });

  it("an explicit removeConditions in the SAME call wins over the automation", async () => {
    const id = tokenId(pageId, "Priest C");
    const { text } = await h.callTool("update_token_hp", {
      characterName: "Priest C", damage: 28, removeConditions: ["wounded"],
    });

    expect(bar(id)).toBe(5); // automation would have applied Wounded...
    expect(markers(id)).not.toMatch(/Wounded/); // ...but the explicit override runs after and wins
    expect(text).toMatch(/-\[wounded\]/);
  });
});

describe("update_hp_many — threshold automation across a batch", () => {
  it("applies wounded/dead per-target and reports each in the batch summary", async () => {
    const skelA = tokenId(pageId, "Skeleton A");
    const skelB = tokenId(pageId, "Skeleton B");

    // A: 12 -> 6 (wounded, 12<=12 boundary). B: 12 -> 0 (dead).
    const { text } = await h.callTool("update_hp_many", {
      names: ["Skeleton A"],
      damage: 6,
    });
    expect(bar(skelA)).toBe(6);
    expect(markers(skelA)).toContain("Wounded::4444333");
    expect(text).toMatch(/wounded/i);

    const { text: text2 } = await h.callTool("update_hp_many", {
      names: ["Skeleton B"],
      damage: 12,
    });
    expect(bar(skelB)).toBe(0);
    expect(layer(skelB)).toBe("map");
    expect(markers(skelB)).toMatch(/dead/);
    expect(text2).toMatch(/DEAD/);
  });
});
