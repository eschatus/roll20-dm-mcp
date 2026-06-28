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
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // Retries (429/overloaded) happen INSIDE create() with exponential backoff
      // and were invisible — a rate-limited turn looked like a 27s "generation".
      // Set DMW_ANTHROPIC_LOG=info to print each "retrying request in Xms" line;
      // run() below also logs the rate-limit headers whenever a call is slow.
      maxRetries: Number(process.env.DMW_ANTHROPIC_RETRIES) || 3,
      logLevel: (process.env.DMW_ANTHROPIC_LOG as "off" | "error" | "warn" | "info" | "debug") || "warn",
    });
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
    // System prompt is now frozen (roster/phase ride in the user turn), so the
    // tools+system prefix is prompt-cacheable — see the cache_control breakpoint.
    // Take the raw response too, so we can read rate-limit headers + cache usage.
    const t0 = Date.now();
    let res: Anthropic.Message;
    let headers: Headers;
    try {
      // Two cache breakpoints: (1) system → caches tools + frozen persona (render order is
      // tools → system → messages). (2) the LAST message → caches the GROWING conversation tail
      // within an encounter; the history is append-only so the prefix stays byte-stable and each
      // turn re-reads it instead of cold-prefilling the whole transcript. Marked per-request (not
      // mutating history) so only the latest turn carries the breakpoint — staying under the cap.
      const msgs = this.history.map((m, i) => {
        if (i !== this.history.length - 1) return m;
        if (typeof m.content === "string") {
          return { ...m, content: [{ type: "text" as const, text: m.content, cache_control: { type: "ephemeral" as const } }] };
        }
        const arr = m.content as unknown[];
        return { ...m, content: arr.map((b: unknown, j) => (j === arr.length - 1 ? { ...(b as object), cache_control: { type: "ephemeral" } } : b)) };
      }) as Anthropic.MessageParam[];
      const r = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024, // bound prose latency; a tool call + short reply fits easily
        system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
        tools: this.tools,
        messages: msgs,
      }).withResponse();
      res = r.data;
      headers = r.response.headers;
    } catch (e) {
      const err = e as { status?: number; headers?: { get?: (k: string) => string | null } };
      const retryAfter = err.headers?.get?.("retry-after");
      console.error(`[anthropic] request FAILED after ${Date.now() - t0}ms status=${err.status ?? "?"}${retryAfter ? ` retry-after=${retryAfter}s` : ""} — ${(e as Error).message}`);
      throw e;
    }

    // A slow call (or one landing near the limit) is almost always rate-limit
    // backoff, not generation. Surface the headers so the cause is visible.
    const elapsed = Date.now() - t0;
    const reqRemaining = headers.get("anthropic-ratelimit-requests-remaining");
    const tokRemaining = headers.get("anthropic-ratelimit-tokens-remaining");
    if (elapsed > 6000 || (reqRemaining !== null && Number(reqRemaining) < 2) || (tokRemaining !== null && Number(tokRemaining) < 2000)) {
      const reset = headers.get("anthropic-ratelimit-tokens-reset") || headers.get("anthropic-ratelimit-requests-reset");
      console.error(`[anthropic] SLOW ${elapsed}ms — likely rate-limit backoff. req_remaining=${reqRemaining} tok_remaining=${tokRemaining}${reset ? ` reset=${reset}` : ""}`);
    }

    // Cache visibility: confirm the tools+system prefix is actually being reused.
    const cr = res.usage.cache_read_input_tokens ?? 0, cw = res.usage.cache_creation_input_tokens ?? 0;
    if (cr || cw) console.error(`[anthropic] cache read=${cr} write=${cw} uncached_in=${res.usage.input_tokens}`);

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
