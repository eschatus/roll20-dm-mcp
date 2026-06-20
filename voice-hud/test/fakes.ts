// Deterministic test doubles for the phase-machine harness.
//
// These replace the three live seams of the voice HUD so P1-P6 run with no
// human, no mic, no Whisper, no Electron, and no live Roll20:
//   1. transcript  — injected straight into DmAgent.handle() ("the chat line")
//   2. McpRoll20    — FakeMcp records every call() and returns canned reads
//   3. LLMProvider  — FakeProvider.run() drains a scripted queue of turns

import type { McpTool } from "../src/mcp";
import type { Roll20McpLike } from "../src/agent";
import type { AgentCallbacks, DmPhase } from "../src/agent";
import type { LLMProvider, LLMTurn, ToolSpec, ProviderName } from "../src/llm";

/** A recorded MCP invocation. */
export interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Records every tool call and serves canned read results. No network, no Roll20.
 * `reads` maps a tool name → the string the real server would return; anything
 * unmapped returns "{}". Default reads keep the cleanup macro from looping.
 */
export class FakeMcp implements Roll20McpLike {
  calls: RecordedCall[] = [];
  reads: Record<string, string> = { get_turn_order: "[]", list_zones: "[]", list_tokens: "[]" };
  private catalog: McpTool[];

  constructor(catalog?: McpTool[]) {
    // A minimal catalog covering every tool the phase macros reference, so
    // toolSpecs() filtering produces a non-empty schema. Descriptions are stubs.
    this.catalog = catalog ?? PHASE_TOOL_NAMES.map((name) => ({
      name,
      description: `stub:${name}`,
      inputSchema: { type: "object", properties: {} },
    }));
  }

  getTools(): McpTool[] { return this.catalog; }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    this.calls.push({ name, args });
    return this.reads[name] ?? "{}";
  }

  /** Names of calls in invocation order — handy for sequence assertions. */
  names(): string[] { return this.calls.map((c) => c.name); }

  /** First recorded call for a tool, or undefined. */
  find(name: string): RecordedCall | undefined { return this.calls.find((c) => c.name === name); }
}

/**
 * Deterministic LLM stand-in. `run()` returns the next scripted LLMTurn, or an
 * empty (no-tool) turn once the queue drains — which makes runTurn() terminate
 * in one step. Conversation-state methods are inert.
 */
export class FakeProvider implements LLMProvider {
  readonly name = "fake";
  queue: LLMTurn[];
  runs = 0;

  constructor(queue: LLMTurn[] = []) { this.queue = queue; }

  start(_system: string, _tools: ToolSpec[]): void {}
  setSystem(_system: string): void {}
  pushUser(_text: string): void {}
  pushToolResults(_results: { id: string; name: string; content: string }[]): void {}
  pushContinue(_note: string): void {}
  repair(): void {}
  reset(): void { this.queue = []; }

  async run(): Promise<LLMTurn> {
    this.runs++;
    return this.queue.shift() ?? { text: "", toolCalls: [], truncated: false };
  }
}

/** A provider factory that always returns the supplied FakeProvider (any name). */
export function fakeFactory(p: FakeProvider): (name: ProviderName) => LLMProvider {
  return () => p;
}

/** Records callback activity and answers write proposals from a scripted policy. */
export interface RecordingCallbacks extends AgentCallbacks {
  texts: string[];
  toolStarts: RecordedCall[];
  proposals: RecordedCall[];
  phases: DmPhase[];
}

/**
 * Build AgentCallbacks that record everything and approve/deny writes via
 * `approve` (default: approve all). Set approve=false to exercise the cancel
 * path — denied writes never reach the FakeMcp.
 */
export function recordingCallbacks(approve: boolean | ((name: string) => boolean) = true): RecordingCallbacks {
  const decide = typeof approve === "function" ? approve : () => approve;
  const cb: RecordingCallbacks = {
    texts: [],
    toolStarts: [],
    proposals: [],
    phases: [],
    onText(t) { cb.texts.push(t); },
    onToolStart(name, args) { cb.toolStarts.push({ name, args: (args ?? {}) as Record<string, unknown> }); },
    onToolResult() {},
    async onProposeWrite(name, args) { cb.proposals.push({ name, args }); return decide(name); },
    onPhaseChange(phase) { cb.phases.push(phase); },
  };
  return cb;
}

// Tool names referenced by any phase macro or allowlist — enough for the fake
// catalog. Kept in sync with config.ts phase allowlists + the macro backbones.
const PHASE_TOOL_NAMES = [
  "active_campaign", "switch_campaign", "get_current_page", "list_tokens", "get_token",
  "get_turn_order", "roll_initiative", "set_token_props", "batch_exec", "plan_all_tactics",
  "set_turn_hook", "clear_turn_order", "list_zones", "clear_zone", "sync_character_state",
  "update_token_hp", "update_hp_many", "set_token_marker", "send_narration",
];
