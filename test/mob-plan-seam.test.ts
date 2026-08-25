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

  it("clear:true removes the stored plan", async () => {
    const { text } = await h.callTool("set_mob_plan", { characterName: "Ghoul", clear: true });
    expect(text).toMatch(/cleared/);
    const { json } = await h.callTool("get_mob_plans", {});
    expect((json as PlanStore)[ghoulId]).toBeUndefined();
  });

  it("requires shortTerm unless clearing", async () => {
    await expect(h.callTool("set_mob_plan", { characterName: "Ghoul" })).rejects.toThrow(/shortTerm/);
  });
});
