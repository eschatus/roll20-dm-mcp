// Polymorphic LLM provider interface. The agent loop depends ONLY on this — it
// has no knowledge of Anthropic vs. Ollama vs. anything future. To add a backend,
// implement LLMProvider and register it in the factory (llm/index.ts). Nothing in
// agent.ts changes.

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// One model turn's result, normalized across providers.
export interface LLMTurn {
  text: string;            // assistant prose (may be empty)
  toolCalls: ToolCall[];   // requested tool calls (may be empty)
  truncated: boolean;      // hit the output-token ceiling before finishing
}

// A provider owns its own conversation state (each backend has a different message
// shape). The agent drives it through these provider-agnostic operations.
export interface LLMProvider {
  readonly name: string;

  // Begin a fresh conversation with this system prompt + tool set.
  start(systemPrompt: string, tools: ToolSpec[]): void;

  // Update the system prompt mid-conversation (e.g. the live roster changed).
  setSystem(systemPrompt: string): void;

  // Append the DM's spoken/typed input as the next user turn.
  pushUser(text: string): void;

  // Append tool results (keyed by the ToolCall.id they answer).
  pushToolResults(results: { id: string; name: string; content: string }[]): void;

  // Nudge the model to continue after a truncated turn.
  pushContinue(note: string): void;

  // Run one model turn against the current conversation state.
  run(): Promise<LLMTurn>;

  // Drop a dangling unanswered tool-call turn left by an interrupted run, so the
  // next turn starts from a valid state.
  repair(): void;

  reset(): void;
}
