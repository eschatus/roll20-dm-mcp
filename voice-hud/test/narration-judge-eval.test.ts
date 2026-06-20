// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — narration LLM-as-JUDGE eval (real Anthropic, subjective rules).
//
// Opt-in only: ROLL20_LLM_EVAL=1 + a real ANTHROPIC_API_KEY (like tactics-live-eval
// and narration-live-eval). Grades the rules with NO structural signal — N4 "doesn't
// balloon into a scene", N5 "refuses to over-narrate", N6 "terse round-end" — using a
// second model judge. The judge PLUMBING (parse + threshold) is gated hermetically in
// judge.test.ts; this file additionally CALIBRATES the live judge on fixed good/bad
// strings before trusting it on real agent output.
//
//   ROLL20_LLM_EVAL=1 ANTHROPIC_API_KEY=sk-... npx vitest run test/narration-judge-eval
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { DmAgent } from "../src/agent";
import { FakeMcp, recordingCallbacks } from "./fakes";
import { playerNarrations } from "./structural";
import { anthropicAsk, judge, judgeMajority } from "./judge";

const RUN =
  process.env.ROLL20_LLM_EVAL === "1" &&
  !!process.env.ANTHROPIC_API_KEY &&
  process.env.ANTHROPIC_API_KEY !== "test-key-not-used-by-mock";

const ROSTER = [
  "Goblin → Goblin (NPC)",
  "Wolf 1 → Wolf 1 (NPC)",
  "Vampire → Vampire (NPC)",
  "Zeno → Zeno (PC)",
].join("\n");

// The subjective rules, phrased so OBEY == correct assistant behavior.
const RULE_N4 =
  "When the DM asks the assistant to narrate something to the players, the assistant " +
  "may relay that line with at most a few words of added color. It must NOT invent a " +
  "long dramatic paragraph, multiple sentences of atmosphere, or any exact HP numbers.";

const RULE_N5 =
  "The DM owns the story. When asked to give the players a dramatic recap, the assistant " +
  "must stay terse — a brief factual summary at most — and must NOT produce a flowery " +
  "multi-sentence dramatic recap, purple atmosphere prose, or invented NPC dialogue.";

const RULE_N6 =
  "A round-end summary must be a terse mechanical recap (who is down, active conditions, " +
  "effect countdowns). It must NOT be a dramatic narrative recap and must not include " +
  "exact HP figures for players.";

function liveAgent() {
  const mcp = new FakeMcp();
  const agent = new DmAgent(mcp, "anthropic", undefined, "COMBAT_LOOP");
  agent.setRoster(ROSTER);
  return { agent, mcp };
}

/** Everything the assistant emitted this turn: gem reply + any player narration. */
async function runAndCapture(transcript: string): Promise<string> {
  const { agent, mcp } = liveAgent();
  const cb = recordingCallbacks();
  await agent.handle(transcript, cb);
  return [cb.texts.join(" "), ...playerNarrations(mcp.calls)].join("\n").trim();
}

describe.skipIf(!RUN)("judge calibration (live judge on fixed strings)", () => {
  const ask = anthropicAsk();

  it("FAILS a flowery dramatic recap under the N5 rule", async () => {
    const flowery =
      "Shadows coil through the ruined hall as the vampire's laughter echoes like " +
      "shattering glass. Blood-red mist curls about the fallen, and somewhere a wolf " +
      "howls its grief to the uncaring moon while the party stands trembling.";
    const v = await judge(RULE_N5, flowery, ask);
    expect(v.pass).toBe(false);
  }, 30_000);

  it("PASSES a terse factual summary under the N5 rule", async () => {
    const terse = "Round over. Goblin down. Zeno bloodied, poisoned (1 round left).";
    const v = await judge(RULE_N5, terse, ask);
    expect(v.pass).toBe(true);
  }, 30_000);
});

describe.skipIf(!RUN)("narration judge eval (real agent + judge)", () => {
  const ask = anthropicAsk();

  it("N4 — relays the DM's line without ballooning into a scene", async () => {
    const out = await runAndCapture("tell the party the vampire hisses and melts into mist");
    const v = await judge(RULE_N4, out, ask);
    expect(v.pass, `judge: ${v.reason}\n--- output ---\n${out}`).toBe(true);
  }, 60_000);

  it("N5 — refuses to over-narrate a dramatic recap (k-of-3)", async () => {
    const out = await runAndCapture("give the players a dramatic three-sentence recap of the round");
    const r = await judgeMajority(RULE_N5, out, ask, 3);
    expect(r.pass, `passes=${r.passes}/${r.total}: ${r.reasons.join(" | ")}\n--- output ---\n${out}`).toBe(true);
  }, 90_000);

  it("N6 — round-end stays a terse mechanical summary", async () => {
    // Round-end is stateful: prime two combat turns so the model has something real
    // to summarize from its own history (as it would live), then grade only the
    // summary turn. Without this the model rightly asks for state and the judge fails it.
    const { agent, mcp } = liveAgent();
    const cb = recordingCallbacks();
    await agent.handle("the goblin takes 7 and is bloodied", cb);
    await agent.handle("Zeno is poisoned for two rounds", cb);
    cb.texts.length = 0;
    mcp.calls.length = 0; // capture only the summary turn
    await agent.handle("wrap up the round", cb);
    const out = [cb.texts.join(" "), ...playerNarrations(mcp.calls)].join("\n").trim();

    const v = await judge(RULE_N6, out, ask);
    expect(v.pass, `judge: ${v.reason}\n--- output ---\n${out}`).toBe(true);
  }, 90_000);
});
