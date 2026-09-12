import { describe, it, expect } from "vitest";
import { normalizeNameForMatch, isPunctuationOnlyInput } from "./nameMatch.js";

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

  // PR #198 review, finding 3 (Devin): stripping punctuation to NOTHING
  // collapses adjacent words across the stripped separator ("Rigan,Stormcrow"
  // -> "riganstormcrow"), which can then never match "Rigan Stormcrow" even
  // though punctuation-insensitive lookup is the whole point. Replacing with
  // a space (then collapsing whitespace runs, as already happened) fixes
  // this without disturbing any #195 case: a real space-separated phrase
  // just gets a redundant space that the collapse removes, and a hyphen
  // (untouched, see above) is unaffected either way.
  it("replaces punctuation with a space (not nothing) so adjacent words don't fuse together", () => {
    expect(normalizeNameForMatch("Rigan,Stormcrow")).toBe("rigan stormcrow");
    expect(normalizeNameForMatch("Rigan,Stormcrow")).toBe(normalizeNameForMatch("Rigan Stormcrow"));
  });

  it("still folds the original #195 comma-before-epithet case the same way after the space fix", () => {
    expect(normalizeNameForMatch("Bandit Captain, The Scarred")).toBe("bandit captain the scarred");
  });
});

// PR #198 review, finding 1 (Devin) — the most serious of the three: every
// by-name matcher touched by #195 feeds a normalized value into
// String.prototype.includes() as a substring "needle". normalizeNameForMatch(",")
// is "" (comma -> space -> trimmed away), and "".includes("") plus
// anyName.includes("") are BOTH true — so an unguarded caller treats a
// punctuation-only selector as a wildcard that matches every name on the
// board. isPunctuationOnlyInput is the shared guard every touched matcher
// (resolveToken, resolveCharacterKey, resolveNamesToTokens, isSidekickToken,
// update_hp_many's nameMatch, roll_initiative's nameFilter/nameMatches) now
// checks before treating a normalized value as a real search term.
describe("isPunctuationOnlyInput", () => {
  it("is true for input made entirely of the stripped punctuation marks", () => {
    expect(isPunctuationOnlyInput(",")).toBe(true);
    expect(isPunctuationOnlyInput("...")).toBe(true);
    expect(isPunctuationOnlyInput(";;")).toBe(true);
    expect(isPunctuationOnlyInput(" , . ; : ")).toBe(true); // punctuation + whitespace only
  });

  it("is false for a genuinely empty/whitespace-only/undefined input — that legitimately means 'no selector', not a wildcard", () => {
    expect(isPunctuationOnlyInput("")).toBe(false);
    expect(isPunctuationOnlyInput("   ")).toBe(false);
    expect(isPunctuationOnlyInput(undefined)).toBe(false);
    expect(isPunctuationOnlyInput(null)).toBe(false);
  });

  it("is false for real content, punctuated or not", () => {
    expect(isPunctuationOnlyInput("Ogre")).toBe(false);
    expect(isPunctuationOnlyInput("Bandit Captain, the Scarred")).toBe(false);
    expect(isPunctuationOnlyInput("Road-Worn")).toBe(false); // hyphen alone is real content (not stripped)
  });

  it("a hyphen-only input is NOT punctuation-only (a hyphen is not in PUNCT_RE)", () => {
    expect(isPunctuationOnlyInput("-")).toBe(false);
    expect(normalizeNameForMatch("-")).toBe("-");
  });
});
