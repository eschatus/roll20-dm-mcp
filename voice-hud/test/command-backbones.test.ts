// Deterministic, offline port of TEST-PLAN.md section 3 — the choreography
// backbones and the write-confirmation gate. The human's only irreplaceable job
// (speaking) is replaced by injecting transcript strings straight into
// DmAgent.handle(). No mic, no Whisper, no Electron, no live Roll20.
//
// This file replaces the old phase-machine.test.ts. The phase state machine is
// gone (see docs/phase-removal.md); what survives — and what still matters — is
// that each explicit command runs its ordering-critical backbone correctly, and
// that no command consumes the DM's turn. The "capability is never gated"
// half of that contract lives in no-phase-regression.test.ts.
//
// What this CANNOT cover (still needs a human at the gem): mic capture, Whisper
// transcription accuracy, the Electron overlay render, and the global PTT hotkey.
// Those rows stay flagged in TEST-PLAN.md.

import { describe, it, expect } from "vitest";
import {
  DmAgent,
  detectCallForInit,
  detectBeginCombat,
  detectCombatOver,
} from "../src/agent";
import { FakeMcp, FakeProvider, fakeFactory, recordingCallbacks } from "./fakes";

/** Build a fresh agent wired to deterministic fakes (cloud provider → no escalation). */
function makeAgent() {
  const mcp = new FakeMcp();
  const provider = new FakeProvider();           // empty queue → runTurn is a one-step no-op
  const agent = new DmAgent(mcp, "anthropic", fakeFactory(provider));
  return { agent, mcp, provider };
}

// ---------------------------------------------------------------------------
// Tier 0 — command detectors (pure phrase logic)
// ---------------------------------------------------------------------------

describe("command detectors", () => {
  it("detectCallForInit fires on initiative phrasings", () => {
    expect(detectCallForInit("Roll initiative.")).toBe(true);
    expect(detectCallForInit("everyone roll")).toBe(true);
    expect(detectCallForInit("roll for init")).toBe(true);
  });

  it("detectBeginCombat fires on start phrasings", () => {
    expect(detectBeginCombat("Sort it, let's start.")).toBe(true);
    expect(detectBeginCombat("round one")).toBe(true);
    expect(detectBeginCombat("start the fight")).toBe(true);
  });

  it("detectCombatOver requires a deliberate close phrase", () => {
    expect(detectCombatOver("Combat's over.")).toBe(true);
    expect(detectCombatOver("the fight's done")).toBe(true);
    expect(detectCombatOver("end of combat")).toBe(true);
    // High-precision: vague winding-down must NOT close combat.
    expect(detectCombatOver("The fight feels like it might be winding down.")).toBe(false);
  });

  it("KNOWN GAP: the copula form is not recognized", () => {
    // Pre-existing, unchanged by the phase removal: the pattern matches
    // "combat's over" / "fight's done" but not "combat IS over". Harmless now
    // that nothing is gated on it (the DM just says it again, or the model
    // clears the order itself) — but worth pinning so it isn't mistaken for a
    // regression later. Widening the regex is a separate, low-risk change.
    expect(detectCombatOver("combat is over")).toBe(false);
    expect(detectCombatOver("the fight is done")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backbones — each runs from a cold agent, in any order, with no ceremony
// ---------------------------------------------------------------------------

describe("INIT-PREP backbone", () => {
  it("rolls NPC-only initiative (never wipes players) and queues tactics", async () => {
    const { agent, mcp } = makeAgent();
    await agent.handle("Roll initiative.", recordingCallbacks());

    // Safety-critical: NPC-only with clearFirst=false so player entries survive.
    // This is the whole reason the backbone exists rather than trusting the model.
    expect(mcp.find("roll_initiative")?.args).toEqual({ npcOnly: true, clearFirst: false });
    expect(mcp.find("plan_all_tactics")).toBeDefined();
  });

  it("runs from a cold start — no prior command required", async () => {
    // Under the old machine this needed IDLE→SCENE_SET first, or it was ignored.
    const { agent, mcp } = makeAgent();
    await agent.handle("everyone roll", recordingCallbacks());
    expect(mcp.find("roll_initiative")).toBeDefined();
  });
});

describe("BEGIN-COMBAT backbone", () => {
  it("arms the turn hook before reading the settled order", async () => {
    const { agent, mcp } = makeAgent();
    await agent.handle("Sort it, let's start.", recordingCallbacks());

    expect(mcp.find("set_turn_hook")?.args).toEqual({ enabled: true, reset: true });
    expect(mcp.names()).toContain("get_turn_order");
    expect(mcp.names().indexOf("set_turn_hook"))
      .toBeLessThan(mcp.names().indexOf("get_turn_order"));
  });
});

describe("CLEANUP backbone", () => {
  it("vague 'winding down' does NOT trigger cleanup", async () => {
    const { agent, mcp } = makeAgent();
    await agent.handle("The fight feels like it might be winding down.", recordingCallbacks());

    expect(mcp.find("clear_turn_order")).toBeUndefined();
    expect(mcp.find("set_turn_hook")).toBeUndefined();
  });

  it("explicit \"combat's over\" disarms the hook, clears order, sweeps zones", async () => {
    const { agent, mcp } = makeAgent();
    const cb = recordingCallbacks();
    await agent.handle("Combat's over.", cb);

    expect(mcp.find("set_turn_hook")?.args).toEqual({ enabled: false });
    expect(mcp.find("clear_turn_order")).toBeDefined();
    expect(mcp.names()).toContain("list_zones");
    // Fires the AAR hook exactly once.
    expect(cb.combatEnds).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A full arc still works end to end — without any state to sequence it
// ---------------------------------------------------------------------------

describe("full combat arc", () => {
  it("init → begin → close runs every backbone in order", async () => {
    const { agent, mcp } = makeAgent();
    const cb = recordingCallbacks();

    await agent.handle("Roll initiative.", cb);
    await agent.handle("Sort it, let's start.", cb);
    await agent.handle("Combat's over.", cb);

    const names = mcp.names();
    expect(names.indexOf("roll_initiative")).toBeLessThan(names.indexOf("get_turn_order"));
    expect(names.indexOf("get_turn_order")).toBeLessThan(names.indexOf("clear_turn_order"));
    expect(cb.combatEnds).toBe(1);
  });

  it("the arc can be run out of order without locking anything out", async () => {
    // The old machine rejected these as illegal transitions and silently ignored
    // the command; now each simply runs its backbone.
    const { agent, mcp } = makeAgent();
    const cb = recordingCallbacks();

    await agent.handle("Combat's over.", cb);   // close before opening
    await agent.handle("Roll initiative.", cb); // then open
    expect(mcp.find("clear_turn_order")).toBeDefined();
    expect(mcp.find("roll_initiative")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// R2 — the write-confirmation gate actually blocks
// ---------------------------------------------------------------------------

describe("R2 — confirm gate", () => {
  it("a denied write is proposed but never reaches the tabletop", async () => {
    const { agent, mcp } = makeAgent();
    const cb = recordingCallbacks(false); // cancel every write

    await agent.handle("Roll initiative.", cb);

    expect(cb.proposals.some((p) => p.name === "roll_initiative")).toBe(true);
    // Cancelled → the fake MCP never saw the call.
    expect(mcp.find("roll_initiative")).toBeUndefined();
  });
});
