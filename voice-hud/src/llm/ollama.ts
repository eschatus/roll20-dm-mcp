// Ollama provider — local, via Ollama's OpenAI-compatible /v1 endpoint.
// Owns OpenAI-shaped chat history. Used for the HUD agent (tool-calling).

import OpenAI from "openai";
import { LLMProvider, LLMTurn, ToolSpec } from "./provider";

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  private client: OpenAI;
  private history: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private tools: OpenAI.Chat.ChatCompletionTool[] = [];

  constructor(private model: string, baseURL: string) {
    // Ollama ignores the key, but the SDK requires a non-empty one.
    this.client = new OpenAI({ baseURL, apiKey: "ollama" });
  }

  start(systemPrompt: string, tools: ToolSpec[]): void {
    this.history = [{ role: "system", content: systemPrompt }];
    this.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  setSystem(systemPrompt: string): void {
    if (this.history.length && this.history[0].role === "system") {
      this.history[0] = { role: "system", content: systemPrompt };
    } else {
      this.history.unshift({ role: "system", content: systemPrompt });
    }
  }

  pushUser(text: string): void {
    if (this.history.length === 0) this.history.push({ role: "system", content: "" });
    this.history.push({ role: "user", content: text });
  }

  pushToolResults(results: { id: string; name: string; content: string }[]): void {
    for (const r of results) this.history.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }

  pushContinue(note: string): void {
    this.history.push({ role: "user", content: note });
  }

  async run(): Promise<LLMTurn> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: this.history,
      tools: this.tools.length ? this.tools : undefined,
      max_tokens: 1024,
      // Ollama's OpenAI endpoint defaults num_ctx to 2048 — too small once tools +
      // system prompt are in. Raise it so the conversation isn't silently truncated
      // (which makes a small model "forget" the system prompt mid-combat).
      // Passed through as an Ollama option via the extra body.
      // @ts-expect-error non-standard Ollama passthrough
      options: { num_ctx: Number(process.env.DMW_OLLAMA_NUM_CTX) || 8192 },
    });
    const msg = res.choices[0].message;
    this.history.push(msg);

    const toolCalls = (msg.tool_calls ?? [])
      .filter((c) => c.type === "function")
      .map((c) => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* empty */ }
        return { id: c.id, name: c.function.name, args };
      });

    return {
      text: (msg.content || "").trim(),
      toolCalls,
      truncated: res.choices[0].finish_reason === "length",
    };
  }

  repair(): void {
    const last = this.history[this.history.length - 1];
    if (last && last.role === "assistant" && (last as { tool_calls?: unknown }).tool_calls) this.history.pop();
  }

  reset(): void { this.history = []; }
}
