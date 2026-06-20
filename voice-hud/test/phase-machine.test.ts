// Deterministic, offline port of TEST-PLAN.md section 3 (P1-P6) plus the fuzzy
// detector layer. The human's only irreplaceable job — speaking — is replaced by
// injecting transcript strings straight into DmAgent.handle() ("the chat line").
// No mic, no Whisper, no Electron, no live Roll20.
//
// What this CANNOT cover (still needs a human at the gem): mic capture, Whisper
// transcription accuracy, the Electron overlay render, and the global PTT hotkey.
// Those rows stay flagged in TEST-PLAN.md.

import { describe, it, expect } from "vitest";
import {
  DmAgent,
  detectSceneSet,
  detectCallForInit,
  detectBeginCombat,
  detectCombatOver,
} from "../src/agent";
import { CONFIG } from "../src/config";
import { FakeMcp, FakeProvider, fakeFactory, recordingCallbacks } from "./fakes";

// The P1 opening narration from TEST-PLAN.md.
const SCENE_NARRATION =
  "The party finds themselves atop Mount Baratok in the Curse of Strahd, and are " +
  "surprised when suddenly they're beset by several vampires and many children of " +
  "the night represented by wolves and swarms of bats.";

/** Build a fresh agent wired to deterministic fakes (cloud provider → no escalation). */
function makeAgent() {
  const mcp = new FakeMcp();
  const provider = new FakeProvider();           // empty queue → runTurn is a one-step no-op
  const agent = new DmAgent(mcp, "anthropic", fakeFactory(provider));
  return { agent, mcp, provider };
}

// ---------------------------------------------------------------------------
// Tier 0 — detectors (pure phrase → transition logic)
// ---------------------------------------------------------------------------

describe("phase detectors", () => {
  it("detectSceneSet fires on opening combat narration", () => {
    expect(detectSceneSet(SCENE_NARRATION)).toBe(true);
    expect(detectSceneSet("a band of goblins ambushes you in the dark")).toBe(true);
  });

  it("detectSceneSet survives STT mishears of the combatants", () => {
    // Whisper noise still carries the combat noun — fuzzy entry should hold.
    expect(detectSceneSet("they are beset by several vampire spawn and dire wolves")).toBe(true);
  });

  it("detectSceneSet stays quiet on ordinary table talk", () => {
    expect(detectSceneSet("let's take a short break and grab snacks")).toBe(false);
  });

  it("detectCallForInit fires on initiative phrasings", () => {
    expect(detectCallForInit("Roll initiative.")).toBe(true);
    expect(detectCallForInit("everyone roll")).toBe(true);
    expect(detectCallForInit("roll for init")).toBe(true);
  });

  it("detectBeginCombat fires on start phrasings", () => {
    expect(detectBeginCombat("Sort it, let's start.")).toBe(true);
    expect(detectBeginCombat("round one, first turn")).toBe(true);
  });

  it("detectCombatOver requires a deliberate close phrase", () => {
    expect(detectCombatOver("Combat's over.")).toBe(true);
    expect(detectCombatOver("the fight's done")).toBe(true);
    // The key negative (P5): vague winding-down must NOT read as a close.
    expect(detectCombatOver("The fight feels like it might be winding down.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tier 1 — phase machine via handle() with recording fakes
// ---------------------------------------------------------------------------

describe("phase transitions (P1-P3, P5)", () => {
  it("P1 — fuzzy scene-set entry from opening narration", async () => {
    const { agent, mcp } = makeAgent();
    const cb = recordingCallbacks();

    expect(agent.currentPhase()).toBe("IDLE");
    await agent.handle(SCENE_NARRATION, cb);

    expect(agent.currentPhase()).toBe("SCENE_SET");
    expect(cb.phases).toContain("SCENE_SET");
    // Scene-set is silent to players and proposes no writes.
    expect(cb.proposals).toHaveLength(0);
    expect(mcp.find("send_narration")).toBeUndefined();
  });

  it("P2 — init-prep rolls NPC-only initiative (never wipes players)", async () => {
    const { agent, mcp } = makeAgent();
    const cb = recordingCallbacks(); // approve all writes

    await agent.handle(SCENE_NARRATION, cb);   // → SCENE_SET
    await agent.handle("Roll initiative.", cb); // → INIT_PREP

    expect(agent.currentPhase()).toBe("INIT_PREP");
    // Safety-critical: the roll must be NPC-only with clearFirst=false so player
    // entries survive. This is the whole reason the macro exists.
    const roll = mcp.find("roll_initiative");
    expect(roll?.args).toEqual({ npcOnly: true, clearFirst: false });
    expect(mcp.find("plan_all_tactics")).toBeDefined();
  });

  it("P3 — begin combat arms the turn hook and reads the order", async () => {
    const { agent, mcp } = makeAgent();
    const cb = recordingCallbacks();

    await agent.handle(SCENE_NARRATION, cb);
    await agent.handle("Roll initiative.", cb);
    await agent.handle("Sort it, let's start.", cb); // → COMBAT_LOOP

    expect(agent.currentPhase()).toBe("COMBAT_LOOP");
    expect(mcp.find("set_turn_hook")?.args).toEqual({ enabled: true, reset: true });
    // The hook is armed before the order is read back.
    expect(mcp.names()).toContain("get_turn_order");
    expect(mcp.names().indexOf("set_turn_hook")).toBeLessThan(mcp.names().indexOf("get_turn_order"));
  });

  it("P5 — vague 'winding down' does NOT trigger cleanup", async () => {
    const { agent, mcp } = makeAgent();
    const cb = recordingCallbacks();

    await agent.handle(SCENE_NARRATION, cb);
    await agent.handle("Roll initiative.", cb);
    await agent.handle("Sort it, let's start.", cb);
    mcp.calls.length = 0; // ignore setup calls

    await agent.handle("The fight feels like it might be winding down.", cb);

    expect(agent.currentPhase()).toBe("COMBAT_LOOP"); // unchanged
    expect(mcp.find("clear_turn_order")).toBeUndefined();
    expect(mcp.find("set_turn_hook")).toBeUndefined();
  });

  it("P5 — explicit 'combat's over' runs the cleanup backbone → IDLE", async () => {
    const { agent, mcp } = makeAgent();
    const cb = recordingCallbacks();

    await agent.handle(SCENE_NARRATION, cb);
    await agent.handle("Roll initiative.", cb);
    await agent.handle("Sort it, let's start.", cb);
    mcp.calls.length = 0; // isolate cleanup's calls (set_turn_hook fires in beginCombat too)
    await agent.handle("Combat's over.", cb); // → CLEANUP → IDLE

    expect(agent.currentPhase()).toBe("IDLE");
    // Each backbone step fired through the gate.
    expect(mcp.find("set_turn_hook")?.args).toEqual({ enabled: false });
    expect(mcp.find("clear_turn_order")).toBeDefined();
    expect(mcp.names()).toContain("list_zones");
  });
});

// ---------------------------------------------------------------------------
// P4 — idle scoping is enforced by the phase allowlist (schema-level)
// ---------------------------------------------------------------------------

describe("P4 — IDLE toolset is read-only", () => {
  // The agent gates writes but does NOT re-check the allowlist at execution time;
  // out-of-combat safety comes from never offering HP/condition tools in IDLE.
  // So the precise assertion is on the phase allowlist the model is handed.
  it("IDLE excludes HP and condition tools", () => {
    const idle = CONFIG.phaseTools.IDLE;
    expect(idle).not.toContain("update_token_hp");
    expect(idle).not.toContain("update_hp_many");
    expect(idle).not.toContain("set_token_marker");
    expect(idle).not.toContain("roll_initiative");
  });

  it("COMBAT_LOOP includes the live-combat write tools", () => {
    const combat = CONFIG.phaseTools.COMBAT_LOOP;
    expect(combat).toContain("update_token_hp");
    expect(combat).toContain("set_token_marker");
  });
});

// ---------------------------------------------------------------------------
// P6 — every transition surfaces via onPhaseChange
// ---------------------------------------------------------------------------

describe("P6 — phase changes are observable", () => {
  it("a full combat arc emits the expected phase sequence", async () => {
    const { agent } = makeAgent();
    const cb = recordingCallbacks();

    await agent.handle(SCENE_NARRATION, cb);
    await agent.handle("Roll initiative.", cb);
    await agent.handle("Sort it, let's start.", cb);
    await agent.handle("Combat's over.", cb);

    expect(cb.phases).toEqual(["SCENE_SET", "INIT_PREP", "COMBAT_LOOP", "CLEANUP", "IDLE"]);
  });
});

// ---------------------------------------------------------------------------
// R2 — the write-confirmation gate actually blocks
// ---------------------------------------------------------------------------

describe("R2 — confirm gate", () => {
  it("a denied write is proposed but never reaches the tabletop", async () => {
    const { agent, mcp } = makeAgent();
    const cb = recordingCallbacks(false); // cancel every write

    await agent.handle(SCENE_NARRATION, cb);
    await agent.handle("Roll initiative.", cb); // initPrep proposes roll_initiative

    expect(cb.proposals.some((p) => p.name === "roll_initiative")).toBe(true);
    // Cancelled → the fake MCP never saw the call.
    expect(mcp.find("roll_initiative")).toBeUndefined();
  });
});
