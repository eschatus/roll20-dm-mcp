import { describe, it, expect } from "vitest";
import { parseLog, combatWindow, analyzeCombat, renderReport, type LogLine } from "../src/aar";

const line = (msg: string): LogLine => ({ ts: 1, msg });

// A representative combat window (the kind hud.log captures).
const WINDOW: LogLine[] = [
  "[agent] phase → COMBAT_LOOP",
  '[agent] turn start: "the goblin attacks"',
  "[agent] step 0 (anthropic) gen 1399ms (text:0 tools:1)",
  "[agent] tool → roll_initiative({names:...})",
  "[agent] tool ✓ roll_initiative: MCP error -32602: Input validation error",
  "[agent] turn DONE 5926ms, 3 steps",
  '[correct] "hair gone" → "Haregon"',
  "[agent] tool ✓ update_token_hp: Ambiguous target \"hargon\". Did you mean: Haregon, Hargrove?",
  "[agent] tool ✓ ↑escalate: complex narration → cloud (haiku)",
  "[agent] turn DONE 8000ms, 6 steps",
  "[agent] phase → CLEANUP",
].map(line);

describe("parseLog", () => {
  it("parses JSONL log lines and skips malformed", () => {
    const raw = '{"ts":1,"msg":"a"}\nnot json\n{"ts":2,"msg":"b"}\n{"ts":3}';
    expect(parseLog(raw).map((l) => l.msg)).toEqual(["a", "b"]);
  });
});

describe("combatWindow", () => {
  it("slices to the last COMBAT_LOOP → CLEANUP", () => {
    const lines = [line("noise before"), ...WINDOW, line("noise after")];
    const w = combatWindow(lines).map((l) => l.msg);
    expect(w[0]).toContain("COMBAT_LOOP");
    expect(w.at(-1)).toContain("CLEANUP");
    expect(w).not.toContain("noise before");
    expect(w).not.toContain("noise after");
  });
  it("returns everything when there are no phase markers", () => {
    const lines = [line("a"), line("b")];
    expect(combatWindow(lines)).toHaveLength(2);
  });
});

describe("analyzeCombat", () => {
  const r = analyzeCombat(WINDOW);

  it("computes turn efficiency", () => {
    expect(r.turns).toBe(2);
    expect(r.avgSteps).toBe(4.5);              // (3 + 6) / 2
    expect(r.struggledTurns).toHaveLength(1);  // the 6-step turn
    expect(r.struggledTurns[0].steps).toBe(6);
    expect(r.escalations).toBe(1);
  });

  it("captures tool errors (logged with ✓ but carrying an error payload)", () => {
    expect(r.toolErrors.some((e) => e.tool === "roll_initiative" && /validation/i.test(e.detail))).toBe(true);
  });

  it("records applied STT corrections", () => {
    expect(r.correctionsApplied).toContainEqual({ from: "hair gone", to: "Haregon" });
  });

  it("turns clarifications into proposals, best candidate first", () => {
    expect(r.clarifications).toContainEqual({ spoken: "hargon", candidates: ["Haregon", "Hargrove"] });
    expect(r.proposals[0].spoken).toBe("hargon");
    expect(r.proposals[0].suggested).toBe("Haregon"); // closest to "hargon" by edit distance
    expect(r.proposals[0].candidates).toEqual(["Haregon", "Hargrove"]);
  });

  it("sorts proposals by recurrence (the rerank signal)", () => {
    const w = [...WINDOW];
    // a second, more-frequent clarification
    for (let i = 0; i < 3; i++) w.push(line('[agent] tool ✓ x: Ambiguous target "san cho". Did you mean: Sancho?'));
    const r2 = analyzeCombat(w);
    expect(r2.proposals[0].spoken).toBe("san cho"); // 3 > 1
    expect(r2.proposals[0].count).toBe(3);
  });
});

describe("renderReport", () => {
  it("renders the headline + proposals", () => {
    const md = renderReport(analyzeCombat(WINDOW));
    expect(md).toContain("After-Action Review");
    expect(md).toContain("avg 4.5 steps/turn");
    expect(md).toContain("Proposed learned corrections");
    expect(md).toContain("Haregon");
  });
});
