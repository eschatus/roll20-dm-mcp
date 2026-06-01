import { describe, it, expect } from "vitest";
import { resolveCharacterKey, type CharacterEntry } from "./characters.js";

function entry(): CharacterEntry {
  return { roll20TokenId: "tok", ddbCharId: 1 };
}

describe("resolveCharacterKey", () => {
  const reg: Record<string, CharacterEntry> = {
    eli: entry(),
    "rigan stormcrow": entry(),
    winsome: entry(),
  };

  it("returns the exact key for a case-insensitive exact match", () => {
    expect(resolveCharacterKey("Eli", reg)).toBe("eli");
    expect(resolveCharacterKey("eli", reg)).toBe("eli");
  });

  it("matches when the query is a substring of a key", () => {
    expect(resolveCharacterKey("Rigan", reg)).toBe("rigan stormcrow");
  });

  it("matches when a key is a substring of the query", () => {
    expect(resolveCharacterKey("Winsome the Bard", reg)).toBe("winsome");
  });

  it("returns null when nothing matches", () => {
    expect(resolveCharacterKey("Strahd", reg)).toBeNull();
  });

  it("returns null against an empty registry", () => {
    expect(resolveCharacterKey("Eli", {})).toBeNull();
  });
});
