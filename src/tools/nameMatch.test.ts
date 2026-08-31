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

  // Issue #195 (DM follow-up comment): a hyphen JOINS a compound word/epithet
  // ("Road-Worn") — it is not sentence punctuation that ends a run like
  // ",.;:" — so it must NOT be in PUNCT_RE. This is the actual guard rail:
  // it pins the literal normalized string, so it fails immediately if a
  // hyphen is ever added to the stripped set (which would collapse
  // "Road-Worn" to "roadworn", silently losing the token). Verified this is
  // load-bearing: an integration test that only asserts "Road-Worn resolves"
  // does NOT catch this regression on its own — normalizeNameForMatch runs on
  // both the query and the token name, so stripping the hyphen symmetrically
  // still leaves them equal to each other and resolution still succeeds; only
  // a test that pins this exact output (this one), or one that puts a
  // hyphenated and unhyphenated form of the same name into collision, would
  // notice. See test/token-name-punctuation.test.ts for the resolution-level
  // companion case (the "Bandit Captain the Road-Worn" fixture row).
  it("does NOT strip a hyphen — it joins a compound word, sentence punctuation ends a run", () => {
    expect(normalizeNameForMatch("Road-Worn")).toBe("road-worn");
    expect(normalizeNameForMatch("Bandit Captain the Road-Worn")).toBe("bandit captain the road-worn");
  });
});
