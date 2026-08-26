// ─────────────────────────────────────────────────────────────────────────────
// set_mob_plan (#171 seam) — the mob-plan storage primitive, decoupled from the
// server-side tactics cascade so an external brain (the gem) can store plans.
// Asserts the full seam: relay state via getMobPlans, the auto-rendered whisper
// card, the immediate SSE push (publishMobPlan), and clearing.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import { onRtdbEvent, type RtdbBroadcastEvent } from "../src/bridge/roll20-rt.js";

let h: Harness;
let pageId: string;
let ghoulId: string;

const events: RtdbBroadcastEvent[] = [];
let unsub: () => void;

type PlanStore = Record<string, { html: string; plan: { name: string; shortTerm: string; mediumTerm?: string; longGoal?: string } | null }>;

beforeAll(() => {
  h = setupHarness({ seed: 41 });
  pageId = h.emu.createPage("Mob Plan Seam");
  h.emu.setPlayerPage(pageId);
  ghoulId = h.emu.createToken({
    pageid: pageId, name: "Ghoul", controlledby: "", bar1_value: 22, bar1_max: 22, left: 140, top: 140,
  }).id;
  unsub = onRtdbEvent((e) => events.push(e));
});

afterAll(() => {
  unsub();
  h.teardown();
});

describe("set_mob_plan", () => {
  it("stores a plan by characterName, renders a card, and pushes it to the HUD", async () => {
    const { text } = await h.callTool("set_mob_plan", {
      characterName: "Ghoul",
      shortTerm: "Claw the nearest lightly-armored PC",
      mediumTerm: "Retreat to the crypt door at half HP",
      longGoal: "Protect the necromancer",
    });
    expect(text).toMatch(/Mob plan stored for Ghoul/);

    // Relay state — readable back exactly as plan_all_tactics' plans are.
    const { json } = await h.callTool("get_mob_plans", {});
    const plans = json as PlanStore;
    expect(plans[ghoulId]?.plan).toEqual({
      name: "Ghoul",
      shortTerm: "Claw the nearest lightly-armored PC",
      mediumTerm: "Retreat to the crypt door at half HP",
      longGoal: "Protect the necromancer",
    });
    // Auto-rendered whisper card carries the plan text, HTML-escaped inline-styled block.
    expect(plans[ghoulId]?.html).toContain("Ghoul");
    expect(plans[ghoulId]?.html).toContain("Claw the nearest lightly-armored PC");

    // Immediate SSE push, same channel the tactics cascade uses.
    const push = events.find((e) => e.type === "mob-plan");
    expect(push).toMatchObject({ type: "mob-plan", tokenId: ghoulId, plan: { name: "Ghoul" } });
  });

  it("uses caller-supplied HTML verbatim when given", async () => {
    await h.callTool("set_mob_plan", {
      tokenId: ghoulId,
      shortTerm: "Bite",
      html: "<div class='custom-card'>Bite</div>",
    });
    const { json } = await h.callTool("get_mob_plans", {});
    expect((json as PlanStore)[ghoulId]?.html).toBe("<div class='custom-card'>Bite</div>");
  });

  it("clear:true removes the stored plan and pushes the clear to the HUD", async () => {
    events.length = 0;
    const { text } = await h.callTool("set_mob_plan", { characterName: "Ghoul", clear: true });
    expect(text).toMatch(/cleared/);
    const { json } = await h.callTool("get_mob_plans", {});
    expect((json as PlanStore)[ghoulId]).toBeUndefined();
    // The HUD must drop the card, not keep showing a stale plan for a dead mob.
    expect(events).toContainEqual({ type: "mob-plan", tokenId: ghoulId, plan: null });
  });

  it("requires shortTerm unless clearing", async () => {
    await expect(h.callTool("set_mob_plan", { characterName: "Ghoul" })).rejects.toThrow(/shortTerm/);
  });
});

describe("clear_mob_plans", () => {
  // Deleting the tactics cascade in Phase 2 Half A also deleted clear_tactic_memory,
  // which was the only caller of the clearMobPlans relay action — leaving no way to
  // wipe plans in bulk. A live campaign was found holding 28 stale ones, which the
  // turn hook would whisper again the next time those tokens came up.
  it("wipes every stored plan and tells the HUD to drop each card", async () => {
    await h.callTool("set_mob_plan", { characterName: "Ghoul", shortTerm: "Claw" });
    const second = h.emu.createToken({
      pageid: pageId, name: "Ghast", controlledby: "", bar1_value: 30, bar1_max: 30, left: 210, top: 140,
    });
    await h.callTool("set_mob_plan", { tokenId: second.id, shortTerm: "Flank" });
    expect(Object.keys((await h.callTool("get_mob_plans", {})).json as PlanStore)).toHaveLength(2);

    events.length = 0;
    const { text } = await h.callTool("clear_mob_plans", {});
    expect(text).toMatch(/Cleared 2 stored mob plan/);
    expect((await h.callTool("get_mob_plans", {})).json).toEqual({});
    // Both cards dropped, not just the last one.
    expect(events).toContainEqual({ type: "mob-plan", tokenId: ghoulId, plan: null });
    expect(events).toContainEqual({ type: "mob-plan", tokenId: second.id, plan: null });
  });

  it("is a no-op that still reports honestly when nothing is stored", async () => {
    const { text } = await h.callTool("clear_mob_plans", {});
    expect(text).toMatch(/Cleared 0 stored mob plan/);
  });
});
