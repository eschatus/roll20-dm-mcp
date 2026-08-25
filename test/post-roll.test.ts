// ─────────────────────────────────────────────────────────────────────────────
// post_roll_as_character (#171 seam) — the Roll20 half of the roll-pump split.
// An external brain (the gem) rolls or receives dice elsewhere and hands the
// finished numbers here; the tool renders a native-looking default-template
// card into chat AS the character via the existing postChat relay action,
// never re-rolling. renderRollCard is also covered directly: template-breaking
// chars stripped, inline-roll brackets neutralized, redundant breakdown elided.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import { renderRollCard } from "../src/tools/combatHelpers.js";

describe("renderRollCard", () => {
  it("renders label, notation, total, and breakdown", () => {
    const card = renderRollCard("Longbow Attack", [
      { label: "To Hit", notation: "1d20+7", total: 23, breakdown: "16+7" },
      { label: "Damage", notation: "1d8+3", total: 9, breakdown: "6+3" },
    ]);
    expect(card).toBe(
      "&{template:default} {{name=Longbow Attack}} {{To Hit 1d20+7 = 23 (16+7)}} {{Damage 1d8+3 = 9 (6+3)}}"
    );
  });

  it("elides a breakdown that just repeats the total, and tolerates missing notation", () => {
    const card = renderRollCard("Check", [{ label: "Stealth", total: 14, breakdown: "14" }]);
    expect(card).toBe("&{template:default} {{name=Check}} {{Stealth = 14}}");
  });

  it("strips template-breaking chars and neutralizes inline-roll brackets", () => {
    const card = renderRollCard("Sneaky {title} | trick", [
      { label: "Attack", notation: "[[1d20+5]]", total: 18 },
    ]);
    // No {{…}} injection from user text, and no [[…]] Roll20 would re-roll.
    expect(card).toContain("{{name=Sneaky title  trick}}");
    expect(card).toContain("{{Attack [1d20+5] = 18}}");
    expect(card).not.toMatch(/\[\[/);
  });
});

describe("post_roll_as_character (emulator)", () => {
  let h: Harness;

  beforeAll(() => {
    h = setupHarness({ seed: 9 });
    const pageId = h.emu.createPage("Post Roll Test");
    h.emu.setPlayerPage(pageId);
  });
  afterAll(() => h.teardown());

  it("posts the rendered card into chat as the named character", async () => {
    const { text } = await h.callTool("post_roll_as_character", {
      characterName: "Salros Eventide",
      title: "Wisdom Save — via D&D Beyond",
      rolls: [{ label: "Wisdom Save", notation: "1d20+4", total: 17, breakdown: "13+4" }],
    });

    expect(text).toMatch(/Posted 1 roll row\(s\) to chat as Salros Eventide/);
    const posted = h.emu.chatLog.find((m) => m.who === "Salros Eventide");
    expect(posted).toBeDefined();
    expect(posted!.content).toBe(
      "&{template:default} {{name=Wisdom Save — via D&D Beyond}} {{Wisdom Save 1d20+4 = 17 (13+4)}}"
    );
  });

  it("accepts a JSON-stringified rolls array (model compatibility)", async () => {
    await h.callTool("post_roll_as_character", {
      characterName: "Amri",
      rolls: JSON.stringify([{ label: "Initiative", total: 12 }]),
    });
    const posted = h.emu.chatLog.find((m) => m.who === "Amri");
    expect(posted!.content).toBe("&{template:default} {{name=Dice roll}} {{Initiative = 12}}");
  });
});
