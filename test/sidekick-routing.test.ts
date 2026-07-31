// ─────────────────────────────────────────────────────────────────────────────
// Issue #132 — sidekick HP/death routing.
//
// Token classing is THREE-way: PC (Beyond20-owned bar, tracked shadow HP), NPC
// (bar1), and SIDEKICK — a player-controlled token (Tua, Salros Eventide, Amri
// in the Firebirds campaign) whose HP nonetheless lives in bar1 and who dies
// like an NPC (immediate dead marker + map layer, no dying/death-saves state).
// `controlledby` alone can't tell a sidekick from a true PC — both are
// player-controlled — so the registry's per-character `sidekick: true`
// override (set via set_token_class) is what disambiguates.
//
// This suite drives the REAL update_token_hp / kill_token MCP handlers against
// the emulator (mod-scripts/ai-relay.js in a vm sandbox), exactly like
// pc-bar-invariant.test.ts, with a sidekick token as the new case and a true
// PC token (same controlledby shape) as the control group proving the
// override — not just controlledby — is what drives the routing.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import * as characters from "../src/registry/characters.js";

let h: Harness;

const bar = (id: string) => Number(h.emu.tokenProps(id).bar1_value);
const gmnotes = (id: string) => String(h.emu.tokenProps(id).gmnotes ?? "");
const layer = (id: string) => String(h.emu.tokenProps(id).layer ?? "");
const markers = (id: string) => String(h.emu.tokenProps(id).statusmarkers ?? "");

function parsePcHp(notes: string): { current: number; max: number } | null {
  const m = notes.match(/%%PCHP=(\{[\s\S]*?\})%%/);
  if (!m) return null;
  try { return JSON.parse(m[1]) as { current: number; max: number }; }
  catch { return null; }
}

function tokenId(pageId: string, name: string): string {
  const tokens = h.emu.relay<Array<{ id: string; name: string }>>({ action: "getTokens", pageId });
  const tok = tokens.find((t) => t.name === name);
  if (!tok) throw new Error(`Token not found in emulator: ${name}`);
  return tok.id;
}

let pageId: string;

beforeAll(() => {
  h = setupHarness({ seed: 132 });
  pageId = h.emu.createPage("Sidekick Routing Tests");
  h.emu.setPlayerPage(pageId);

  // A true PC — player-controlled, NOT flagged sidekick. Control group proving
  // the registry override (not controlledby) is what drives routing.
  h.emu.createToken({
    pageid: pageId, name: "Glint Klinkinski", controlledby: "player-glint",
    bar1_value: 30, bar1_max: 30,
  });

  // A sidekick — player-controlled, flagged via set_token_class / setSidekick.
  h.emu.createToken({
    pageid: pageId, name: "Tua", controlledby: "player-glint",
    bar1_value: 22, bar1_max: 22,
  });
  characters.setSidekick("Tua", true);

  // Second sidekick, to exercise splitPcNpc/update_hp_many with a mixed batch.
  h.emu.createToken({
    pageid: pageId, name: "Amri", controlledby: "player-other",
    bar1_value: 18, bar1_max: 18,
  });
  characters.setSidekick("Amri", true);
});

afterAll(() => h.teardown());

describe("set_token_class (registry override, voice-settable)", () => {
  it("flags a character sidekick and reports the routing note", async () => {
    const { text } = await h.callTool("set_token_class", { characterName: "Amri", tokenClass: "sidekick" });
    expect(text).toMatch(/Amri set to sidekick/);
    expect(text).toMatch(/bar1/);
  });

  it("tokenClass:'pc' clears the override", async () => {
    characters.setSidekick("Test Clear Me", true);
    const { text } = await h.callTool("set_token_class", { characterName: "Test Clear Me", tokenClass: "pc" });
    expect(text).toMatch(/Test Clear Me set to pc/);
    expect(characters.isSidekick("Test Clear Me")).toBe(false);
  });
});

describe("update_token_hp — three-way routing table", () => {
  it("PC: bar1 untouched, HP tracked in relay state, '(tracked)' reported", async () => {
    const id = tokenId(pageId, "Glint Klinkinski");
    const barBefore = bar(id);

    const { text } = await h.callTool("update_token_hp", { tokenId: id, damage: 10 });

    expect(bar(id)).toBe(barBefore); // bar1 never written for a PC
    const pchp = parsePcHp(gmnotes(id));
    expect(pchp).not.toBeNull();
    expect(pchp!.current).toBe(barBefore - 10);
    expect(text).toMatch(/\(tracked\)/);
  });

  it("SIDEKICK: bar1 IS written directly, no tracked-state block, no '(tracked)' tag", async () => {
    const id = tokenId(pageId, "Tua");
    const barBefore = bar(id); // 22

    const { text } = await h.callTool("update_token_hp", { tokenId: id, damage: 12 });

    // Golden pair #5 (docs/table-mechanics-golden-pairs.md): "Priest B hurls
    // thunder at Tua — she takes 12" → bar1 12→10, not tracked state.
    expect(bar(id)).toBe(barBefore - 12); // 10
    expect(parsePcHp(gmnotes(id))).toBeNull(); // no PC tracked-HP block written
    expect(text).not.toMatch(/\(tracked\)/);
  });
});

describe("update_hp_many — mixed PC/sidekick/NPC batch", () => {
  it("routes the sidekick to bar1 alongside NPCs while the true PC stays tracked", async () => {
    // Reset a fresh NPC into the mix so this test doesn't depend on order.
    h.emu.createToken({ pageid: pageId, name: "Kraken Priest", controlledby: "", bar1_value: 33, bar1_max: 33 });

    const glintId = tokenId(pageId, "Glint Klinkinski");
    const amriId = tokenId(pageId, "Amri");
    const priestId = tokenId(pageId, "Kraken Priest");
    const glintBarBefore = bar(glintId);
    const amriBarBefore = bar(amriId);

    const { text } = await h.callTool("update_hp_many", {
      names: ["Glint Klinkinski", "Amri", "Kraken Priest"],
      damage: 5,
    });

    expect(bar(glintId)).toBe(glintBarBefore); // PC bar untouched
    expect(bar(amriId)).toBe(amriBarBefore - 5); // sidekick bar written
    expect(bar(priestId)).toBe(28); // NPC bar written, control group
    expect(text).toMatch(/Amri.*\d+\/\d+/);
  });
});

describe("kill_token — sidekick death path (NPC semantics, not PC dying state)", () => {
  it("marks the sidekick dead and moves it to the map layer immediately, same as an NPC", async () => {
    const id = tokenId(pageId, "Amri");
    expect(layer(id)).not.toBe("map");

    await h.callTool("kill_token", { characterName: "Amri" });

    expect(layer(id)).toBe("map");
    // "dead" shares the Unconscious marker tag (see CONDITION_MARKERS in combat.ts).
    expect(markers(id)).toMatch(/dead/);
  });

  it("kill_token is available for the sidekick without any PC-style dying/death-save state", async () => {
    // Regression guard: the sidekick death path is exactly kill_token (no
    // separate PC "unconscious + death saves" flow ever runs for a sidekick).
    const id = tokenId(pageId, "Tua");
    await h.callTool("kill_token", { characterName: "Tua" });
    expect(layer(id)).toBe("map");
    expect(markers(id)).toMatch(/dead/);
  });
});
