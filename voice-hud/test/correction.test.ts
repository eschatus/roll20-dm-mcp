import { describe, it, expect } from "vitest";
import {
  correctTranscript, normalizeNotation, applyLiteralMap, fuzzyPhoneticCorrect,
} from "../src/correction";

const ROSTER = ["Haregon", "Limbda", "Sancho", "Curtain Call", "saving throw", "initiative", "Barovia"];

describe("pass 1 — notation", () => {
  it("normalizes dice spoken forms", () => {
    expect(normalizeNotation("roll two dee six")).toBe("roll 2d6");
    expect(normalizeNotation("make a dee twenty check")).toBe("make a d20 check");
    expect(normalizeNotation("that's a d six")).toBe("that's a d6");
  });
  it("normalizes nat twenty", () => {
    expect(normalizeNotation("he got a nat twenty")).toBe("he got a nat 20");
    expect(normalizeNotation("natural twenty!")).toBe("nat 20!");
  });
  it("does NOT touch ordinary words containing d", () => {
    expect(normalizeNotation("he had ten gold")).toBe("he had ten gold");
  });
});

describe("pass 2 — literal map", () => {
  it("swaps exact phrases", () => {
    expect(applyLiteralMap("the dee see is fifteen", { "dee see": "DC" })).toBe("the DC is fifteen");
  });
});

describe("pass 3 — fuzzy + phonetic (split names)", () => {
  it("joins a despaced multi-word span to a single-word name (the split-name case)", () => {
    expect(fuzzyPhoneticCorrect("hair gone attacks", ROSTER)).toBe("Haregon attacks");
    expect(fuzzyPhoneticCorrect("san cho moves", ROSTER)).toBe("Sancho moves");
  });
  it("leaves a span that doesn't phonetically agree (precision over recall)", () => {
    // "lim duh" (metaphone LMT) ≠ "Limbda" (LMPT) — intentionally NOT forced; loosening
    // to catch it would also let "cave" (KF) → "save" (SF). Stubborn names go in the
    // literal map instead. A missed correction is cheap; a wrong one corrupts the parse.
    expect(fuzzyPhoneticCorrect("lim duh casts", ROSTER)).toBe("lim duh casts");
  });
  it("resolves a multi-word term before its fragments (greedy longest-match)", () => {
    expect(fuzzyPhoneticCorrect("they use curtain call now", ROSTER)).toBe("they use Curtain Call now");
  });
  it("canonicalizes casing for an otherwise-correct name", () => {
    expect(fuzzyPhoneticCorrect("haregon strikes", ROSTER)).toBe("Haregon strikes");
  });
});

describe("pass 3 — precision guards (must NOT clobber real English)", () => {
  it("leaves a common word that's phonetically distinct ('cave' ≠ 'save')", () => {
    expect(fuzzyPhoneticCorrect("into the cave", ["save", "saving throw"])).toBe("into the cave");
  });
  it("leaves ordinary narration untouched", () => {
    const s = "the goblin runs to the wall and hides";
    expect(fuzzyPhoneticCorrect(s, ROSTER)).toBe(s);
  });
  it("guards common words even if a glossary term is phonetically near", () => {
    // "wave" is common; don't turn it into a name/term.
    expect(fuzzyPhoneticCorrect("a wave of fear", ROSTER)).toBe("a wave of fear");
  });
});

describe("orchestrator", () => {
  it("runs all three passes in order", () => {
    const out = correctTranscript("hair gone rolls two dee six for the dee see", {
      glossary: ROSTER,
      literalMap: { "dee see": "DC" },
    });
    expect(out).toBe("Haregon rolls 2d6 for the DC");
  });
  it("each pass is independently toggleable", () => {
    const out = correctTranscript("two dee six", { glossary: ROSTER, notation: false, fuzzy: false, literal: false });
    expect(out).toBe("two dee six");
  });
});
