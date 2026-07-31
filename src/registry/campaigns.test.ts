import { describe, it, expect } from "vitest";
import { toSlug, resolveCampaignSlug, matchCampaignSlugs, type CampaignEntry } from "./campaigns.js";

describe("toSlug", () => {
  it("lowercases and hyphenates", () => {
    expect(toSlug("Curse of Strahd")).toBe("curse-of-strahd");
  });

  it("collapses runs of non-alphanumerics into a single hyphen", () => {
    expect(toSlug("Beyond  the   Phandelver!!")).toBe("beyond-the-phandelver");
  });

  it("strips leading and trailing separators", () => {
    expect(toSlug("  Strahd  ")).toBe("strahd");
    expect(toSlug("-Strahd-")).toBe("strahd");
  });

  it("keeps digits", () => {
    expect(toSlug("Group 1 of 4")).toBe("group-1-of-4");
  });

  it("returns empty string for all-symbol input", () => {
    expect(toSlug("!!!")).toBe("");
  });

  it("is idempotent on an existing slug", () => {
    expect(toSlug("curse-of-strahd")).toBe("curse-of-strahd");
  });
});

function entry(name: string): CampaignEntry {
  return { name, roll20CampaignId: "r", ddbCampaignId: "d" };
}

describe("resolveCampaignSlug", () => {
  const store = {
    "curse-of-strahd": entry("Curse of Strahd"),
    "beyond-phandelver": entry("Beyond Phandelver"),
    "firebirds": entry("Fabulous Faerun Firebirds"),
  };

  it("returns the exact slug when it exists", () => {
    expect(resolveCampaignSlug("curse-of-strahd", store)).toBe("curse-of-strahd");
  });

  it("matches a slug that is a substring of the query slug", () => {
    // toSlug("Curse of Strahd campaign") includes "curse-of-strahd"... but here
    // the registered key is contained in the typed value's slug.
    expect(resolveCampaignSlug("curse-of-strahd-2024", store)).toBe("curse-of-strahd");
  });

  it("matches by display-name substring (case insensitive)", () => {
    expect(resolveCampaignSlug("firebirds", store)).toBe("firebirds");
    expect(resolveCampaignSlug("Faerun", store)).toBe("firebirds");
  });

  it("matches when the registered slug is a substring of the query", () => {
    expect(resolveCampaignSlug("firebirds rock band", store)).toBe("firebirds");
  });

  it("returns null when nothing matches", () => {
    expect(resolveCampaignSlug("nonexistent-campaign", store)).toBeNull();
  });

  it("returns null against an empty store", () => {
    expect(resolveCampaignSlug("anything", {})).toBeNull();
  });
});

// Regression: a vague query used to first-match-win over insertion order and
// silently resolve to the wrong campaign — a whole session ran on the wrong
// board while switch_campaign reported success.
describe("resolveCampaignSlug — sibling campaigns sharing a name prefix", () => {
  const siblings = {
    "phi-sigma-kappa": entry("Phi Sigma Kappa"),
    "8th-street": entry("Dreams of the Red Wizards 8th Street"),
    "three-families": entry("Dreams of the Red Wizards Three Families"),
  };

  it("reports every campaign a vague query could mean", () => {
    expect(matchCampaignSlugs("dreams of the red wizards", siblings).sort()).toEqual([
      "8th-street",
      "three-families",
    ]);
  });

  it("refuses to guess when the query is ambiguous", () => {
    expect(resolveCampaignSlug("dreams of the red wizards", siblings)).toBeNull();
  });

  it("still resolves a query that singles one out", () => {
    expect(resolveCampaignSlug("8th street", siblings)).toBe("8th-street");
    expect(resolveCampaignSlug("phi-sigma-kappa", siblings)).toBe("phi-sigma-kappa");
  });

  it("prefers an exact display-name match over fuzzy siblings", () => {
    // "Dreams of the Red Wizards" as a literal name must not drag in the two
    // campaigns whose names merely START with it.
    const withBare = { ...siblings, "red-wizards": entry("Dreams of the Red Wizards") };
    expect(resolveCampaignSlug("Dreams of the Red Wizards", withBare)).toBe("red-wizards");
  });

  it("prefers an exact slug over a fuzzy match on a longer sibling", () => {
    const nested = { psk: entry("A"), "psk-plus": entry("B") };
    expect(resolveCampaignSlug("psk", nested)).toBe("psk");
  });
});
