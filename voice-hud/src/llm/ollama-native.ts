// Native-Ollama provider — talks to Ollama's own /api/chat endpoint instead of
// its OpenAI-compat /v1 shim. Opt-in via DMW_OLLAMA_NATIVE=1 (see llm/index.ts).
//
// WHY THIS EXISTS: the OpenAI-compat endpoint (ollama.ts) SILENTLY IGNORES the
// `options` bag (num_ctx et al) — that bug invalidated an earlier "local models
// are unusable" verdict (see SFT_RUN_STATE.md / SPECIALIST_MODEL_DECISION.md).
// /api/chat honors `options` for real, and ALSO exposes `format` — a JSON-Schema
// the server grammar-constrains the next generation to (llama.cpp GBNF under the
// hood). /v1 has no equivalent knob.
//
// DMW_CONSTRAIN_TOOLS=1 spends that `format` knob on the failure mode measured in
// SFT_RUN_STATE.md: untrained qwen2.5-7b picks the RIGHT TOOL ~88% of the time but
// only emits fully valid args ~63% of the time (stringified arrays, string
// booleans, wrong param names — the exact -32602 reproduction in eval-tools.ts).
// Tool NAME selection is already effectively constrained for free: Ollama's
// native tool-calling grammar only lets the model emit one of the names in the
// `tools` array it was served, so a first-stage name-only constraint would be
// redundant. What is NOT constrained today is the ARGUMENT object once a name is
// picked — that's a free-form JSON completion the model can (and does) botch.
//
// So the two stages are:
//   1) Ask normally (native tool-calling, tools param) → get {name, draft args}.
//      This is where "which tool" gets decided; leave it alone.
//   2) If a tool was called, re-ask with NO tools param and `format` set to
//      exactly that tool's inputSchema — the server can now only emit JSON shaped
//      like the schema. The stage-1 draft args are handed back in the re-ask
//      prompt (as the thing to correct) so parallel calls to the SAME tool in one
//      turn stay distinct — e.g. two `update_token_hp` for two different targets.
//      Splice the result back in as the call's args.
//
// Degrade safely: some models/ollama builds reject `format` with a schema object
// (older servers, some templates). If stage 2 errors for ANY reason (network,
// non-2xx, bad JSON), log once per process and keep the stage-1 draft args rather
// than losing the turn.
import { LLMProvider, LLMTurn, ToolCall, ToolSpec } from "./provider";

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: { id?: string; function: { name: string; arguments: Record<string, unknown> | string } }[];
  tool_call_id?: string;
  tool_name?: string;
}

let warnedOnce = false;
function warnFallbackOnce(detail: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`[ollama-native] DMW_CONSTRAIN_TOOLS: falling back to unconstrained args after a failure — ${detail}`);
}

// Exported so tests can reset the module-level "logged once" latch between cases.
export function resetConstrainWarningLatch(): void { warnedOnce = false; }

function numCtx(): number {
  return Number(process.env.DMW_OLLAMA_NUM_CTX) || 8192;
}

export class OllamaNativeProvider implements LLMProvider {
  readonly name = "ollama-native";
  private history: OllamaMessage[] = [];
  private tools: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[] = [];
  private specByName = new Map<string, ToolSpec>();
  private nextId = 0;

  constructor(private model: string, private baseUrl: string) {}

  start(systemPrompt: string, tools: ToolSpec[]): void {
    this.history = [{ role: "system", content: systemPrompt }];
    this.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    this.specByName = new Map(tools.map((t) => [t.name, t]));
  }

  setSystem(systemPrompt: string): void {
    if (this.history.length && this.history[0].role === "system") this.history[0] = { role: "system", content: systemPrompt };
    else this.history.unshift({ role: "system", content: systemPrompt });
  }

  pushUser(text: string): void {
    if (this.history.length === 0) this.history.push({ role: "system", content: "" });
    this.history.push({ role: "user", content: text });
  }

  pushToolResults(results: { id: string; name: string; content: string }[]): void {
    for (const r of results) this.history.push({ role: "tool", tool_name: r.name, tool_call_id: r.id, content: r.content });
  }

  pushContinue(note: string): void {
    this.history.push({ role: "user", content: note });
  }

  reset(): void { this.history = []; }

  repair(): void {
    const last = this.history[this.history.length - 1];
    if (last && last.role === "assistant" && last.tool_calls) this.history.pop();
  }

  private async postChat(body: Record<string, unknown>): Promise<{ message: OllamaMessage; done_reason?: string }> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, stream: false, ...body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ollama /api/chat ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json() as Promise<{ message: OllamaMessage; done_reason?: string }>;
  }

  async run(): Promise<LLMTurn> {
    const res = await this.postChat({
      messages: this.history,
      tools: this.tools.length ? this.tools : undefined,
      options: { num_ctx: numCtx() },
    });
    const msg = res.message;
    this.history.push(msg);

    let toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c) => ({
      id: c.id || `call_${this.model}_${this.nextId++}`,
      name: c.function.name,
      args: parseArgs(c.function.arguments),
    }));

    if (process.env.DMW_CONSTRAIN_TOOLS === "1" && toolCalls.length) {
      toolCalls = await Promise.all(toolCalls.map((c) => this.constrainArgs(c)));
      // Reflect the constrained args back into the pushed history message so a
      // later turn's context matches what the caller actually executed.
      if (msg.tool_calls) {
        msg.tool_calls.forEach((raw, i) => { if (toolCalls[i]) raw.function.arguments = toolCalls[i].args; });
      }
    }

    return {
      text: (msg.content || "").trim(),
      toolCalls,
      truncated: res.done_reason === "length",
    };
  }

  // Stage 2: re-ask with format=<tool's JSON schema> to grammar-constrain the
  // argument object. Uses the same context (minus tools — we want a plain JSON
  // completion, not another tool-call decision) plus one instruction turn.
  private async constrainArgs(call: ToolCall): Promise<ToolCall> {
    const spec = this.specByName.get(call.name);
    if (!spec) return call; // unknown tool (shouldn't happen) — nothing to constrain against
    try {
      const res = await this.postChat({
        messages: [
          ...this.history.slice(0, -1),
          {
            role: "user",
            content: `Generate ONLY the JSON arguments object for calling the tool "${call.name}" to satisfy the request above. The draft arguments to correct (fix types/param names, keep the intended target and values) are: ${JSON.stringify(call.args)}. Output JSON matching the schema exactly — no prose, no markdown fences.`,
          },
        ],
        format: spec.parameters,
        options: { num_ctx: numCtx() },
      });
      const parsed = JSON.parse(res.message.content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ...call, args: parsed as Record<string, unknown> };
      throw new Error("constrained completion was not a JSON object");
    } catch (e) {
      warnFallbackOnce(e instanceof Error ? e.message : String(e));
      return call; // keep stage-1's draft args — degrade, don't kill the turn
    }
  }
}

function parseArgs(raw: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof raw === "string") {
    try { return JSON.parse(raw || "{}"); } catch { return {}; }
  }
  return raw ?? {};
}
