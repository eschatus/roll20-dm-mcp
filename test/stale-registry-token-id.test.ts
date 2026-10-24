// ─────────────────────────────────────────────────────────────────────────────
// Issue #240 — resolveToken trusted the registry's roll20TokenId over the live page.
//
// Each Roll20 page carries its own copy of a PC token with its own id. A registered
// character stores ONE id, so after the party changes page it is stale. The registry
// used to answer first, so the live-page lookup that would have found the right token
// never ran and the relay failed with "Token not found". The live page is the source
// of truth: the stored id is honoured only if it is actually on the page.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import * as characters from "../src/registry/characters.js";

let h: Harness;
let oldPage: string;
let newPage: string;
let oldId: string;
let newId: string;

const bar = (id: string) => Number(h.emu.tokenProps(id).bar1_value);

beforeAll(() => {
  h = setupHarness({ seed: 240 });
  oldPage = h.emu.createPage("Treasury");
  newPage = h.emu.createPage("Spectre");
  oldId = h.emu.createToken({ pageid: oldPage, name: "Heinz Craft", controlledby: "", bar1_value: 30, bar1_max: 30 }).id;
  newId = h.emu.createToken({ pageid: newPage, name: "Heinz Craft", controlledby: "", bar1_value: 30, bar1_max: 30 }).id;
  // Registered while the party was on the treasury map.
  characters.register("Heinz Craft", oldId, 1);
  h.emu.setPlayerPage(newPage);
});

afterAll(() => {
  characters.remove("Heinz Craft");
  characters.remove("Ghost PC");
  h.teardown();
});

describe("stale registry roll20TokenId after a page change (issue #240)", () => {
  it("update_token_hp writes the current page's token, not the other page's copy", async () => {
    const r = await h.callTool("update_token_hp", { characterName: "Heinz Craft", damage: 7 });
    expect(r.isError).toBe(false);
    expect(bar(newId)).toBe(23);
    expect(bar(oldId)).toBe(30);
  });

  it("set_token_marker resolves the current page's token", async () => {
    const r = await h.callTool("set_token_marker", { condition: "concentrating", active: true, characterName: "Heinz Craft" });
    expect(r.isError).toBe(false);
    expect(String(h.emu.tokenProps(newId).statusmarkers ?? "")).not.toBe("");
    expect(String(h.emu.tokenProps(oldId).statusmarkers ?? "")).toBe("");
  });

  it("still uses the registry id when it IS on the page", async () => {
    h.emu.setPlayerPage(oldPage);
    const before = bar(oldId);
    await h.callTool("update_token_hp", { characterName: "Heinz Craft", damage: 1 });
    expect(bar(oldId)).toBe(before - 1);
    h.emu.setPlayerPage(newPage);
  });

  it("fails loudly naming the stale id when the page has no matching token", async () => {
    characters.register("Ghost PC", "-Ghost000000000000000", 2);
    const err = await h.callTool("update_token_hp", { characterName: "Ghost PC", damage: 1 }).then(
      () => new Error("expected rejection"),
      (e: Error) => e,
    );
    expect(err.message).toMatch(/Stale registry token id/);
    expect(err.message).toMatch(/-Ghost000000000000000/);
    expect(err.message).not.toMatch(/Reconnect|gem/i);
  });
});
