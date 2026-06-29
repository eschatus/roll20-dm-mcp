import { describe, it, expect } from "vitest";
import {
  statesOutcome, looksComplex, isMutatingTool, isSentinel, decideTerminal,
  PERSISTENCE_NUDGE, COMPLETENESS_CHECK, type TerminalState,
} from "./loop-policy";

describe("statesOutcome", () => {
  it("fires on stated state changes", () => {
    for (const s of [
      "The ogre takes 20 from Thorne's maul.",
      "Thorne is poisoned.",
      "goblin 2 takes 7",
      "The ogre drops.",
      "Web fills the doorway — a 20-ft cube.",
      "next turn",
      "Spirit guardians, fifteen feet.",
      "She casts fireball on the goblins.",
      "Thorne is no longer prone.",
    ]) expect(statesOutcome(s), s).toBe(true);
  });

  it("does NOT fire on questions / lookups (avoid taxing chit-chat)", () => {
    for (const s of [
      "who's hurt?",
      "is the ogre bloodied?",
      "what's Thorne's AC?",
      "how many goblins are left",
      "list the tokens",
      "tell me who's down",
      "show me the turn order",
      "thanks",
      "ok",
      "",
    ]) expect(statesOutcome(s), s).toBe(false);
  });
});

describe("looksComplex", () => {
  it("flags multi-target / multi-effect breaths", () => {
    expect(looksComplex("Fireball on the goblins — 8d6, DEX save DC 15, half on save — and the blast burns the web away.")).toBe(true);
    expect(looksComplex("the whole party heals 8")).toBe(true);
    expect(looksComplex("each skeleton takes 12")).toBe(true);
  });
  it("leaves simple single-effect turns alone", () => {
    expect(looksComplex("goblin 2 takes 7")).toBe(false);
    expect(looksComplex("Thorne is poisoned.")).toBe(false);
  });
});

describe("isMutatingTool", () => {
  it("treats reads as non-mutating and writes as mutating", () => {
    expect(isMutatingTool("list_tokens")).toBe(false);
    expect(isMutatingTool("get_turn_order")).toBe(false);
    expect(isMutatingTool("update_token_hp")).toBe(true);
    expect(isMutatingTool("set_token_marker")).toBe(true);
    expect(isMutatingTool("kill_token")).toBe(true);
    expect(isMutatingTool("resolve_aoe")).toBe(true);
  });
});

describe("isSentinel", () => {
  it("matches the loop-control acknowledgements", () => {
    for (const s of ["DONE", "done.", "NOACTION", "no action", "N/A", "nothing to do"]) expect(isSentinel(s), s).toBe(true);
  });
  it("does not swallow a real reply", () => {
    expect(isSentinel("Goblin 2: 7 dmg → 4/15, bloodied.")).toBe(false);
    expect(isSentinel("Done — the web is cleared and two skeletons fell.")).toBe(false); // has real content after
  });
});

describe("decideTerminal", () => {
  const base: TerminalState = {
    transcript: "Thorne is poisoned.", mutationsThisTurn: 0,
    nudgedAlready: false, completenessCheckedAlready: false, mode: "nudge",
  };

  it("off mode is always legacy done", () => {
    expect(decideTerminal({ ...base, mode: "off" })).toEqual({ kind: "done" });
  });

  it("Failure A: outcome stated, nothing applied → persist nudge once", () => {
    expect(decideTerminal(base)).toEqual({ kind: "nudge", tag: "persist", text: PERSISTENCE_NUDGE });
  });

  it("does not nudge after already nudging (bounded)", () => {
    expect(decideTerminal({ ...base, nudgedAlready: true })).toEqual({ kind: "done" });
  });

  it("does not nudge when the model already acted", () => {
    expect(decideTerminal({ ...base, mutationsThisTurn: 1 })).toEqual({ kind: "done" });
  });

  it("does not nudge a pure question even with zero mutations", () => {
    expect(decideTerminal({ ...base, transcript: "who's hurt?" })).toEqual({ kind: "done" });
  });

  it("Failure B: full mode runs ONE completeness check on a compound turn that acted", () => {
    const compound: TerminalState = {
      ...base, mode: "full", mutationsThisTurn: 1,
      transcript: "Fireball on the goblins — 8d6, DEX save DC 15, half on save — and the blast burns the web away.",
    };
    expect(decideTerminal(compound)).toEqual({ kind: "nudge", tag: "complete", text: COMPLETENESS_CHECK });
    // bounded: not again
    expect(decideTerminal({ ...compound, completenessCheckedAlready: true })).toEqual({ kind: "done" });
  });

  it("nudge mode does NOT run the completeness check (that's full only)", () => {
    const compound: TerminalState = {
      ...base, mode: "nudge", mutationsThisTurn: 1,
      transcript: "Fireball on the goblins — 8d6, DEX save, and the blast burns the web away too.",
    };
    expect(decideTerminal(compound)).toEqual({ kind: "done" });
  });

  it("full mode: simple single-effect turn that acted just finishes (no check)", () => {
    expect(decideTerminal({ ...base, mode: "full", mutationsThisTurn: 1, transcript: "goblin 2 takes 7" }))
      .toEqual({ kind: "done" });
  });
});
