// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — narration LIVE eval (real Anthropic / Haiku).
//
// Opt-in only: set ROLL20_LLM_EVAL=1 and provide a real ANTHROPIC_API_KEY. Makes
// real model calls (costs tokens, non-deterministic, slow), so it is NOT a CI gate
// — like test/tactics-live-eval in the root suite. It catches prompt/model-migration
// regressions by asserting loose STRUCTURAL properties (via test/structural.ts) of
// the real agent's tool calls, never exact prose. The structural checkers themselves
// are gated hermetically in structural.test.ts.
//
//   ROLL20_LLM_EVAL=1 ANTHROPIC_API_KEY=sk-... npx vitest run test/narration-live-eval
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { DmAgent } from "../src/agent";
import { FakeMcp, recordingCallbacks } from "./fakes";
import {
  isBatchedMultiTarget,
  playerNarrationsAreRedacted,
  hpClaimIsBacked,
  hpCalls,
  countTool,
} from "./structural";

const RUN =
  process.env.ROLL20_LLM_EVAL === "1" &&
  !!process.env.ANTHROPIC_API_KEY &&
  process.env.ANTHROPIC_API_KEY !== "test-key-not-used-by-mock";

// A small combat roster so the model resolves names without calling list_tokens.
const ROSTER = [
  "Goblin → Goblin (NPC)",
  "Wolf 1 → Wolf 1 (NPC)",
  "Wolf 2 → Wolf 2 (NPC)",
  "Ogre → Ogre (NPC)",
  "Zeno → Zeno (PC)",
].join("\n");

/** Real agent (live Haiku), recording fake MCP, started already in COMBAT_LOOP. */
function liveAgent() {
  const mcp = new FakeMcp();
  // Default provider factory → real AnthropicProvider; start in COMBAT_LOOP so the
  // HP/condition tools are actually offered to the model (IDLE withholds them).
  const agent = new DmAgent(mcp, "anthropic", undefined, "COMBAT_LOOP");
  agent.setRoster(ROSTER);
  return { agent, mcp };
}

describe.skipIf(!RUN)("narration live eval (real Haiku)", () => {
  it("N1 — single-target damage calls an HP tool on the named target", async () => {
    const { agent, mcp } = liveAgent();
    await agent.handle("the goblin takes 7", recordingCallbacks());
    expect(hpClaimIsBacked(mcp.calls, "Goblin")).toBe(true);
    expect(playerNarrationsAreRedacted(mcp.calls)).toBe(true); // N7: no figures to players
  }, 60_000);

  it("N2 — multi-target is one batched call, not a loop", async () => {
    const { agent, mcp } = liveAgent();
    await agent.handle("fireball — 22 to both wolves and the goblin", recordingCallbacks());
    expect(hpCalls(mcp.calls).length).toBeGreaterThan(0);
    expect(isBatchedMultiTarget(mcp.calls)).toBe(true);
    expect(playerNarrationsAreRedacted(mcp.calls)).toBe(true);
  }, 90_000);

  it("N8 — a claimed hit on Zeno is backed by a real HP call (no phantom)", async () => {
    const { agent, mcp } = liveAgent();
    await agent.handle("the ogre swings at Zeno for 12", recordingCallbacks());
    expect(hpClaimIsBacked(mcp.calls, "Zeno")).toBe(true);
    // And it didn't fan out into single-target loops for one target.
    expect(countTool(mcp.calls, "update_token_hp")).toBeLessThanOrEqual(1);
  }, 60_000);
});
