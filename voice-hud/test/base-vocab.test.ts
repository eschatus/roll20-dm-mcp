import { describe, it, expect } from "vitest";
import { buildVocabPrompt, type CampaignData } from "../src/campaignData";
import { DEFAULT_BASE_VOCAB } from "../src/baseVocab";

const data = (over: Partial<CampaignData> = {}): CampaignData => ({
  slug: "test", vocab: [], nicknames: [], notes: "", ...over,
});

describe("STT base vocab", () => {
  it("DEFAULT_BASE_VOCAB covers the common table terms the DM keeps mishearing", () => {
    for (const term of ["initiative", "saving throw", "advantage", "disadvantage", "armor class", "bonus action"]) {
      expect(DEFAULT_BASE_VOCAB).toContain(term);
    }
  });

  it("always prepends the base set, then campaign vocab + roster + nicknames", () => {
    const prompt = buildVocabPrompt(
      data({ vocab: ["Barovia"], nicknames: [{ nickname: "Z", target: "Zeno" }] }),
      ["Ireena"],
    );
    const terms = prompt.split(", ");
    expect(terms).toContain("initiative"); // base
    expect(terms).toContain("Barovia");    // campaign vocab
    expect(terms).toContain("Ireena");     // roster
    expect(terms).toContain("Z");          // nickname alias
    expect(terms).toContain("Zeno");       // nickname target
  });

  it("dedupes a campaign term that overlaps the base set", () => {
    const prompt = buildVocabPrompt(data({ vocab: ["initiative", "Custom"] }), []);
    expect(prompt.split(", ").filter((t) => t === "initiative")).toHaveLength(1);
    expect(prompt.split(", ")).toContain("Custom");
  });

  it("an explicit baseVocab arg replaces the default (used by the JSON override)", () => {
    const prompt = buildVocabPrompt(data(), [], ["only-this-term"]);
    expect(prompt.split(", ")).toEqual(["only-this-term"]);
  });
});
