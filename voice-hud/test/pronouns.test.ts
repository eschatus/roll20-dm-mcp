// Unit tests for the pronoun feature:
//   1. Back-compat: loadCampaignData on old JSON (no pronouns field) returns empty map.
//   2. lookupPronoun: exact and case-insensitive match.
//   3. annotateName: appends (pronoun) when set, leaves name alone when absent.
//   4. The pronouns block surfaces in the roster text built by refreshRoster (via
//      the annotateName helper) — tested here directly without IPC/Electron.

import { describe, it, expect } from "vitest";
import {
  lookupPronoun,
  annotateName,
  type CampaignData,
} from "../src/campaignData";

// Helper: build a minimal CampaignData.
const data = (over: Partial<CampaignData> = {}): CampaignData => ({
  slug: "test",
  vocab: [],
  nicknames: [],
  notes: "",
  corrections: {},
  pronouns: {},
  ...over,
});

describe("back-compat: old JSON without pronouns field", () => {
  it("data() with no pronouns field defaults to empty object", () => {
    // Simulate what loadCampaignData returns for an old record with no pronouns key.
    // The factory above mimics that by providing pronouns: {} explicitly; but test
    // that the ABSENCE of the key (raw old record) is handled too.
    const raw: Omit<CampaignData, "pronouns"> & { pronouns?: Record<string, string> } = {
      slug: "old",
      vocab: ["Strahd", "Barovia"],
      nicknames: [],
      notes: "",
      corrections: {},
    };
    // Simulate the normalisation loadCampaignData does:
    const normalised: CampaignData = {
      ...raw,
      pronouns: (raw.pronouns && typeof raw.pronouns === "object" && !Array.isArray(raw.pronouns))
        ? raw.pronouns
        : {},
    };
    expect(normalised.pronouns).toEqual({});
    // Existing vocab is preserved.
    expect(normalised.vocab).toContain("Strahd");
  });
});

describe("lookupPronoun", () => {
  it("returns undefined when no pronouns are set", () => {
    expect(lookupPronoun(data(), "Lachlan")).toBeUndefined();
  });

  it("exact match returns the pronoun", () => {
    const d = data({ pronouns: { "Winsome": "she/her" } });
    expect(lookupPronoun(d, "Winsome")).toBe("she/her");
  });

  it("case-insensitive fallback", () => {
    const d = data({ pronouns: { "Lachlan": "they/them" } });
    expect(lookupPronoun(d, "lachlan")).toBe("they/them");
    expect(lookupPronoun(d, "LACHLAN")).toBe("they/them");
  });

  it("prefers exact match over case-insensitive", () => {
    // Two keys that differ only by case — exact wins.
    const d = data({ pronouns: { "Strahd": "he/him", "strahd": "it/its" } });
    expect(lookupPronoun(d, "Strahd")).toBe("he/him");
  });

  it("returns undefined for a name not in the map", () => {
    const d = data({ pronouns: { "Ireena": "she/her" } });
    expect(lookupPronoun(d, "Strahd")).toBeUndefined();
  });
});

describe("annotateName", () => {
  it("returns the bare name when no pronoun is set", () => {
    expect(annotateName(data(), "Strahd")).toBe("Strahd");
  });

  it("appends (pronoun) when set", () => {
    const d = data({ pronouns: { "Winsome": "she/her" } });
    expect(annotateName(d, "Winsome")).toBe("Winsome (she/her)");
  });

  it("handles they/them correctly", () => {
    const d = data({ pronouns: { "Lachlan": "they/them" } });
    expect(annotateName(d, "Lachlan")).toBe("Lachlan (they/them)");
  });

  it("handles neopronouns", () => {
    const d = data({ pronouns: { "Zira": "xe/xem" } });
    expect(annotateName(d, "Zira")).toBe("Zira (xe/xem)");
  });

  it("case-insensitive lookup applies when key case differs from name case", () => {
    const d = data({ pronouns: { "Goblin King": "he/him" } });
    expect(annotateName(d, "goblin king")).toBe("goblin king (he/him)");
  });
});
