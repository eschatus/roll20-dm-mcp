import { describe, it, expect } from "vitest";
import { normalizeNameForMatch } from "./nameMatch.js";

// Issue #195: strip ",.;:" and collapse whitespace, on top of the existing
// case fold every by-name lookup already does.
describe("normalizeNameForMatch", () => {
  it("folds case (pre-existing behavior)", () => {
    expect(normalizeNameForMatch("Bandit Captain")).toBe("bandit captain");
  });

  it("strips a comma before an epithet — the exact issue #195 repro", () => {
    expect(normalizeNameForMatch("Bandit Captain, The Scarred"))
      .toBe(normalizeNameForMatch("Bandit Captain the Scarred"));
    expect(normalizeNameForMatch("Bandit Captain, The Scarred")).toBe("bandit captain the scarred");
  });

  it("strips periods, semicolons, and colons the same way", () => {
    expect(normalizeNameForMatch("Skeleton. The Cursed")).toBe("skeleton the cursed");
    expect(normalizeNameForMatch("Skeleton; The Cursed")).toBe("skeleton the cursed");
    expect(normalizeNameForMatch("Skeleton: The Cursed")).toBe("skeleton the cursed");
  });

  it("collapses whitespace runs left behind by stripped punctuation", () => {
    expect(normalizeNameForMatch("Ogre,   the  Bloated")).toBe("ogre the bloated");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizeNameForMatch("  Ogre  ")).toBe("ogre");
  });

  it("leaves an already-clean name unchanged (identity for the common case)", () => {
    expect(normalizeNameForMatch("ogre")).toBe("ogre");
  });

  it("tolerates null/undefined (defensive — callers pass token.name which can be absent)", () => {
    expect(normalizeNameForMatch(undefined)).toBe("");
    expect(normalizeNameForMatch(null)).toBe("");
    expect(normalizeNameForMatch("")).toBe("");
  });
});
