// ─────────────────────────────────────────────────────────────────────────────
// Graphic properties exposed in #204 — bar-number permission, movement lock,
// scenery/opacity flags, night vision, bar presentation, rollable-token side.
//
// What these tests CAN prove: the tool validates the value, the relay carries it to
// token.set(), and setDefaultToken copies it onto the character's default token
// instead of silently dropping it (the failure mode that ate the aura shape).
// What they CANNOT prove: that Roll20 itself honours a property name — a graphic
// silently discards what it doesn't recognise (#162/#164), and the emulator leaves
// `graphic` unrestricted on purpose. The names here come from the live Objects doc.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupHarness, type Harness } from "./harness.js";

let h: Harness;
let pageId: string;
let tokenId: string;

beforeEach(() => {
  h = setupHarness({ seed: 204 });
  pageId = h.emu.createPage("Props");
  h.emu.setPlayerPage(pageId);
  tokenId = h.emu.createToken({ pageid: pageId, name: "Goblin", bar1_value: 7, bar1_max: 7 }).id;
});

afterEach(() => h.teardown());

const prop = (k: string) => h.emu.getObj("graphic", tokenId)!.get(k);

describe("set_token_props — newly exposed graphic properties", () => {
  it("writes the bar-number permissions, including '' (editors only)", async () => {
    await h.callTool("set_token_props", { tokenId, bar1_num_permission: "hidden" });
    expect(prop("bar1_num_permission")).toBe("hidden");

    await h.callTool("set_token_props", { tokenId, bar1_num_permission: "everyone", bar2_num_permission: "" });
    expect(prop("bar1_num_permission")).toBe("everyone");
    // "" is a real Roll20 value ("only players who can edit this token"), not "unset",
    // so it has to survive the schema and the relay's stripUndef alike.
    expect(prop("bar2_num_permission")).toBe("");
  });

  it("rejects a bar-number permission Roll20 doesn't define", async () => {
    // A graphic DISCARDS an unrecognised value without erroring, so a typo would look
    // like a successful write. Fail at the schema instead.
    await expect(h.callTool("set_token_props", { tokenId, bar1_num_permission: "gm" })).rejects.toThrow();
  });

  it("writes the lock / scenery / fade / vision / bar-presentation flags", async () => {
    await h.callTool("set_token_props", {
      tokenId,
      lockMovement: true,
      renderAsScenery: true,
      baseOpacity: 0.5,
      fadeOnOverlap: false,
      fadeOpacity: 0.2,
      night_vision_effect: "Nocturnal",
      bar_location: "overlap_bottom",
      compact_bar: "compact",
    });
    expect(prop("lockMovement")).toBe(true);
    expect(prop("renderAsScenery")).toBe(true);
    expect(prop("baseOpacity")).toBe(0.5);
    expect(prop("fadeOnOverlap")).toBe(false);
    expect(prop("fadeOpacity")).toBe(0.2);
    expect(prop("night_vision_effect")).toBe("Nocturnal");
    expect(prop("bar_location")).toBe("overlap_bottom");
    expect(prop("compact_bar")).toBe("compact");
  });

  it("keeps opacity inside 0–1", async () => {
    await expect(h.callTool("set_token_props", { tokenId, baseOpacity: 2 })).rejects.toThrow();
    await expect(h.callTool("set_token_props", { tokenId, fadeOpacity: -1 })).rejects.toThrow();
  });

  it("writes currentSide as a number (rollable token side; sandbox v1.5)", async () => {
    await h.callTool("set_token_props", { tokenId, currentSide: 2 });
    expect(prop("currentSide")).toBe(2);
    await expect(h.callTool("set_token_props", { tokenId, currentSide: -1 })).rejects.toThrow();
  });

  it("carries the interaction flags through untouched", async () => {
    await h.callTool("set_token_props", { tokenId, interactionManualReset: true, interactionTriggered: false });
    expect(prop("interactionManualReset")).toBe(true);
    expect(prop("interactionTriggered")).toBe(false);
  });
});

describe("setDefaultToken carries the new properties (#204)", () => {
  it("copies the bar-number permission, lock and scenery flags onto the sheet's default token", async () => {
    const charId = h.emu.createCharacter("Goblin");
    await h.callTool("set_token_props", {
      tokenId,
      bar1_num_permission: "hidden",
      lockMovement: true,
      renderAsScenery: true,
      baseOpacity: 0.4,
      bar_location: "bottom",
      night_vision_effect: "Dimming",
      currentSide: 1,
    });
    h.emu.relay({ action: "setDefaultToken", tokenId, charId });

    const saved = JSON.parse(String(h.emu.getObj("character", charId)!.get("defaulttoken"))) as Record<string, unknown>;
    expect(saved.bar1_num_permission).toBe("hidden");
    expect(saved.lockMovement).toBe(true);
    expect(saved.renderAsScenery).toBe(true);
    expect(saved.baseOpacity).toBe(0.4);
    expect(saved.bar_location).toBe("bottom");
    expect(saved.night_vision_effect).toBe("Dimming");
    // camelCase — the list used to read a lowercase "currentside" that never had a value.
    expect(saved.currentSide).toBe(1);
  });

  it("keeps an EMPTY bar-number permission — '' is stricter than 'everyone', not 'unset'", async () => {
    const charId = h.emu.createCharacter("Guard");
    await h.callTool("set_token_props", { tokenId, bar1_num_permission: "" });
    h.emu.relay({ action: "setDefaultToken", tokenId, charId });

    const saved = JSON.parse(String(h.emu.getObj("character", charId)!.get("defaulttoken"))) as Record<string, unknown>;
    expect(saved).toHaveProperty("bar1_num_permission", "");
    // The blanket empty-value filter still applies to everything else: an unset tint
    // carries no information and must not bloat the default token.
    expect(saved).not.toHaveProperty("tint_color");
  });

  it("does NOT copy the interaction flags — one is a reset action, the other Roll20-owned state", async () => {
    const charId = h.emu.createCharacter("Lever");
    await h.callTool("set_token_props", { tokenId, interactionManualReset: true, interactionTriggered: true });
    h.emu.relay({ action: "setDefaultToken", tokenId, charId });

    const saved = JSON.parse(String(h.emu.getObj("character", charId)!.get("defaulttoken"))) as Record<string, unknown>;
    // A default token carrying interactionManualReset:true would re-fire the reset every
    // time the sheet is dragged onto a map; interactionTriggered would restore stale state.
    expect(saved).not.toHaveProperty("interactionManualReset");
    expect(saved).not.toHaveProperty("interactionTriggered");
  });
});

describe("get_token reads the new properties back (#204)", () => {
  it("reports every newly exposed property, including '' and false", async () => {
    await h.callTool("set_token_props", {
      tokenId,
      bar1_num_permission: "hidden",
      bar2_num_permission: "",
      lockMovement: false,
      renderAsScenery: true,
      baseOpacity: 0.5,
      fadeOnOverlap: false,
      fadeOpacity: 0.2,
      night_vision_effect: "Nocturnal",
      bar_location: "overlap_bottom",
      compact_bar: "compact",
      currentSide: 1,
      interactionManualReset: true,
      interactionTriggered: false,
    });
    const res = await h.callTool("get_token", { tokenId });
    expect(res.isError).toBe(false);
    const t = res.json as Record<string, unknown>;
    expect(t.bar1_num_permission).toBe("hidden");
    expect(t.bar2_num_permission).toBe("");
    expect(t.lockMovement).toBe(false);
    expect(t.renderAsScenery).toBe(true);
    expect(t.baseOpacity).toBe(0.5);
    expect(t.fadeOnOverlap).toBe(false);
    expect(t.fadeOpacity).toBe(0.2);
    expect(t.night_vision_effect).toBe("Nocturnal");
    expect(t.bar_location).toBe("overlap_bottom");
    expect(t.compact_bar).toBe("compact");
    expect(t.currentSide).toBe(1);
    expect(t.interactionManualReset).toBe(true);
    expect(t.interactionTriggered).toBe(false);
  });

  // This asserts the EMULATOR's default for an untouched graphic. Roll20's documented default
  // for bar{n}_num_permission is also "" (editors only), so the two happen to agree — but this
  // test proves the read path keeps "", not what a live Roll20 token holds.
  it("reports the emulator's default '' for an untouched bar-number permission rather than dropping it", async () => {
    const res = await h.callTool("get_token", { tokenId });
    const t = res.json as Record<string, unknown>;
    expect(t).toHaveProperty("bar1_num_permission", "");
  });
});
