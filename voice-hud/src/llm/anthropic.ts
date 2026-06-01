// Anthropic provider — cloud Claude. Owns Anthropic-shaped message history.
// Same LLMProvider contract as Ollama; the agent can't tell them apart.

import Anthropic from "@anthropic-ai/sdk";
import { LLMProvider, LLMTurn, ToolSpec } from "./provider";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private history: Anthropic.MessageParam[] = [];
  private system = "";
  private tools: Anthropic.Tool[] = [];

  constructor(private model: string) {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  start(systemPrompt: string, tools: ToolSpec[]): void {
    this.history = [];
    this.system = systemPrompt;
    this.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  pushUser(text: string): void { this.history.push({ role: "user", content: text }); }

  pushToolResults(results: { id: string; name: string; content: string }[]): void {
    const blocks: Anthropic.ToolResultBlockParam[] = results.map((r) => ({
      type: "tool_result", tool_use_id: r.id, content: r.content,
    }));
    this.history.push({ role: "user", content: blocks });
  }

  pushContinue(note: string): void { this.history.push({ role: "user", content: note }); }

  async run(): Promise<LLMTurn> {
    // The system prompt may carry the live roster; rebuild each call is fine.
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: this.system,
      tools: this.tools,
      messages: this.history,
    });

    let text = "";
    const toolCalls: LLMTurn["toolCalls"] = [];
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, args: (block.input ?? {}) as Record<string, unknown> });
      }
    }
    this.history.push({ role: "assistant", content: res.content });

    return { text: text.trim(), toolCalls, truncated: res.stop_reason === "max_tokens" };
  }

  // Allow the agent to refresh the system prompt (roster changes between turns).
  setSystem(systemPrompt: string): void { this.system = systemPrompt; }

  repair(): void {
    const last = this.history[this.history.length - 1];
    if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return;
    const dangling = last.content.some((b) => typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_use");
    if (dangling) this.history.pop();
  }

  reset(): void { this.history = []; }
}
