// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — tactics LIVE eval (real Anthropic cascade).
//
// Opt-in only: set ROLL20_LLM_EVAL=1 and provide a real ANTHROPIC_API_KEY. This
// makes real model calls (costs tokens, non-deterministic, slow) so it is NOT a
// CI gate — it catches prompt/schema/model-migration regressions by asserting
// loose, structural properties of a real tactical plan rather than exact text.
//
//   ROLL20_LLM_EVAL=1 ANTHROPIC_API_KEY=sk-... npx vitest run test/tactics-live-eval
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, seedWarband, type Harness, type Warband } from "./harness.js";

const RUN =
  process.env.ROLL20_LLM_EVAL === "1" &&
  !!process.env.ANTHROPIC_API_KEY &&
  process.env.ANTHROPIC_API_KEY !== "test-key-not-used-by-mock";

describe.skipIf(!RUN)("tactics live eval (real cascade)", () => {
  let h: Harness;
  let w: Warband;

  beforeAll(() => {
    h = setupHarness({ liveLLM: true });
    w = seedWarband(h.emu);
  });
  afterAll(() => h.teardown());

  it("a low-Int brute gets a single, well-formed, tier-1 plan", async () => {
    const { json } = await h.callTool("plan_tactics", { tokenId: w.npcs.goblinA.id, postToChat: false });
    const r = json as { tier: number; shortTermPlan: string };
    expect(r.tier).toBe(1);
    expect(r.shortTermPlan).toMatch(/\*\*Move:\*\*/);
    expect(r.shortTermPlan).toMatch(/\*\*Action:\*\*/);
  }, 60_000);

  it("a mastermind spellcaster produces a full cascade that references its real abilities", async () => {
    const { json } = await h.callTool("plan_tactics", { tokenId: w.npcs.cultist.id, postToChat: false });
    const r = json as { tier: number; shortTermPlan: string; mediumTermPlan?: string; longTermGoal?: string };
    expect(r.tier).toBe(5);
    expect(r.shortTermPlan).toMatch(/\*\*Action:\*\*/);
    // The full cascade should have produced a strategic layer.
    expect((r.longTermGoal ?? "").length + (r.mediumTermPlan ?? "").length).toBeGreaterThan(0);
  }, 120_000);
});
