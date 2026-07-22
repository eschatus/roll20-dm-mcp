// REGRESSION GUARD for the removal of the phase state machine.
//
// This file began as a characterization of the phase machine (git history has
// the original): every assertion below was once the OPPOSITE, pinning the harms
// that the machine caused. Inverting them is the executable statement of what
// changed. If phases (or any state-dependent gating of capability) ever come
// back, these fail.
//
// Harm IDs match docs/phase-removal.md:
//   H1 capability lockout · H2 turn swallowing · H3 history wipe
//   H4 internals leak to the DM · H5 model claiming state it can't set
//   H6 false-positive scene-set entry

import { describe, it, expect } from "vitest";
import { DmAgent, detectCallForInit, detectBeginCombat, detectCombatOver } from "../src/agent";
import { CONFIG } from "../src/config";
import { buildTurnContext } from "../src/persona";
import { FakeMcp, FakeProvider, fakeFactory, recordingCallbacks } from "./fakes";
import type { LLMTurn, ProviderName } from "../src/llm";

const HP_TOOLS = ["update_token_hp", "set_token_marker", "resolve_aoe", "kill_token"];

function makeAgent(queue: LLMTurn[] = []) {
  const mcp = new FakeMcp();
  const provider = new FakeProvider(queue);
  const agent = new DmAgent(mcp, "anthropic", fakeFactory(provider));
  return { agent, mcp, provider };
}

// ---------------------------------------------------------------------------
// H1 — capability no longer depends on conversational state
// ---------------------------------------------------------------------------

describe("H1 — live-combat tools are ALWAYS available (no phase gating)", () => {
  it("there is no phase allowlist left to gate them", () => {
    expect((CONFIG as Record<string, unknown>).phaseTools).toBeUndefined();
  });

  it("the cloud allowlist carries every live-combat tool", () => {
    for (const t of HP_TOOLS) {
      expect(CONFIG.cloudToolAllowlist).toContain(t);
    }
  });

  it("a cold HP instruction reaches the model with no ceremony first", async () => {
    // The exact shape that failed live: no scene-set, no initiative, no
    // "start combat" — just the instruction, from a fresh agent.
    const queued: LLMTurn[] = [{
      text: "",
      toolCalls: [{
        id: "1",
        name: "update_token_hp",
        args: { characterName: "Sahuagin High Priestess", setHp: 50 },
      }],
      truncated: false,
    }];
    const { agent, mcp } = makeAgent(queued);

    await agent.handle("set the Sahuagin High Priestess's hit points to fifty", recordingCallbacks());

    const call = mcp.find("update_token_hp");
    expect(call).toBeDefined();
    expect(call!.args).toMatchObject({ setHp: 50 });
  });

  it("the model is offered the HP tools on the very first turn", async () => {
    // Capture what start() was handed — the wire payload.
    let offered: string[] = [];
    const mcp = new FakeMcp();
    const provider = new FakeProvider();
    provider.start = (_s, tools) => { offered = tools.map((t) => t.name); };
    const agent = new DmAgent(mcp, "anthropic", (_n: ProviderName) => provider);

    await agent.handle("what's the party's status?", recordingCallbacks());

    // FakeMcp's catalog is the limiting factor, so assert on what it does carry.
    expect(offered).toContain("update_token_hp");
    expect(offered).toContain("set_token_marker");
  });
});

// ---------------------------------------------------------------------------
// H2 — a command backbone never swallows the DM's instruction
// ---------------------------------------------------------------------------

describe("H2 — commands run their backbone AND still route the turn", () => {
  it("'roll initiative, and the ogre takes 5' does both", async () => {
    const queued: LLMTurn[] = [{
      text: "",
      toolCalls: [{ id: "1", name: "update_token_hp", args: { characterName: "Ogre", damage: 5 } }],
      truncated: false,
    }];
    const { agent, mcp, provider } = makeAgent(queued);

    await agent.handle("roll initiative, and the ogre takes 5", recordingCallbacks());

    // Backbone ran...
    expect(mcp.find("roll_initiative")).toBeDefined();
    // ...AND the DM's other instruction was not discarded.
    expect(provider.runs).toBeGreaterThan(0);
    expect(mcp.find("update_token_hp")).toBeDefined();
  });

  it("'combat's over' runs cleanup AND still routes the turn", async () => {
    const { agent, mcp, provider } = makeAgent();
    const cb = recordingCallbacks();

    await agent.handle("combat's over", cb);

    expect(mcp.find("clear_turn_order")).toBeDefined();
    expect(provider.runs).toBeGreaterThan(0);
    // AAR hook fired (replaces the old onPhaseChange("CLEANUP")).
    expect(cb.combatEnds).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// H3 — no mid-session conversation wipe
// ---------------------------------------------------------------------------

describe("H3 — the conversation is seeded once and never reset by a command", () => {
  it("provider.start() is called exactly once across a full combat arc", async () => {
    let starts = 0;
    const mcp = new FakeMcp();
    const provider = new FakeProvider();
    const orig = provider.start.bind(provider);
    provider.start = (s: string, t: Parameters<typeof orig>[1]) => { starts++; return orig(s, t); };
    const agent = new DmAgent(mcp, "anthropic", (_n: ProviderName) => provider);
    const cb = recordingCallbacks();

    await agent.handle("what's the party's status?", cb);
    await agent.handle("the vampires close in", cb);
    await agent.handle("roll initiative", cb);
    await agent.handle("start combat", cb);
    await agent.handle("the ogre takes 9", cb);

    // One seed for the whole arc — history survives, so the cache prefix holds.
    expect(starts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// H4 / H5 — no phase internals in the model's context
// ---------------------------------------------------------------------------

describe("H4/H5 — the prompt carries no phase machinery to leak or lie about", () => {
  it("turn context never announces a phase or refuses on phase grounds", () => {
    const ctx = buildTurnContext("(roster)");
    expect(ctx).not.toMatch(/CURRENT PHASE/i);
    expect(ctx).not.toMatch(/NOT available/i);
    expect(ctx).not.toMatch(/\b(IDLE|SCENE_SET|INIT_PREP|COMBAT_LOOP|CLEANUP)\b/);
  });

  it("turn context depends only on the roster now", () => {
    // Previously this varied by phase; a single argument is the whole input.
    expect(buildTurnContext("(roster)")).toEqual(buildTurnContext("(roster)"));
    expect(buildTurnContext("A")).not.toEqual(buildTurnContext("B"));
  });
});

// ---------------------------------------------------------------------------
// H6 — the fuzzy scene-set detector is gone
// ---------------------------------------------------------------------------

describe("H6 — no fuzzy entry keyed on word form", () => {
  it("detectSceneSet no longer exists", async () => {
    const agentModule = await import("../src/agent");
    expect((agentModule as Record<string, unknown>).detectSceneSet).toBeUndefined();
  });

  it("ordinary combat narration triggers no backbone at all", async () => {
    const { agent, mcp } = makeAgent();
    // Both of these used to be treated inconsistently ("goblin" entered a
    // scene, "vampires" did not). Now neither runs a backbone — they're just
    // turns, and the model has every tool it needs either way.
    await agent.handle("the goblin swings again", recordingCallbacks());
    await agent.handle("the vampires close in", recordingCallbacks());
    expect(mcp.find("roll_initiative")).toBeUndefined();
    expect(mcp.find("set_turn_hook")).toBeUndefined();
    expect(mcp.find("clear_turn_order")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The surviving explicit commands
// ---------------------------------------------------------------------------

describe("explicit commands still recognized (and only those)", () => {
  it("keeps the three high-precision detectors", () => {
    expect(detectCallForInit("roll initiative")).toBe(true);
    expect(detectBeginCombat("start combat")).toBe(true);
    expect(detectCombatOver("combat's over")).toBe(true);
  });

  it("does not fire on ordinary table talk", () => {
    expect(detectCallForInit("pass me the salt")).toBe(false);
    expect(detectBeginCombat("pass me the salt")).toBe(false);
    expect(detectCombatOver("things are winding down")).toBe(false);
  });
});
