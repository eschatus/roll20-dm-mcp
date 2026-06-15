import Anthropic from "@anthropic-ai/sdk";

// ─── Shared Anthropic client ──────────────────────────────────────────────────
//
// Single instance shared by all callers in this process. Prompt-caching header
// is always present — it's harmless on non-cacheable requests.

let anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" },
});

// Test seam — swap in a mock client so callers can run in CI without real API
// calls. Production never calls this.
export function __setAnthropicForTest(client: Pick<Anthropic, "messages">): void {
  anthropic = client as Anthropic;
}

// ─── callModel ────────────────────────────────────────────────────────────────
//
// Unified model-call helper. Wraps the system prompt in a prompt-cache block.
//
// thinkingBudget behaviour:
//   null  → plain call; no thinking field; max_tokens = maxTokens.
//   N > 0 → adaptive thinking; max_tokens = maxTokens + N (adaptive thinking
//             tokens count against max_tokens so we add N as output headroom).
//             `budget_tokens` and `temperature` are NOT sent — both return HTTP
//             400 on current Opus 4 models. The "adaptive" variant is cast via
//             the Record trick because the SDK type union may not include it yet.
//
// Returns the first text block (trimmed). Returns "" when the response has no
// text blocks.

export async function callModel(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  thinkingBudget: number | null = null,
): Promise<string> {
  const params: Anthropic.MessageCreateParams = {
    model,
    max_tokens: thinkingBudget !== null ? maxTokens + thinkingBudget : maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  };

  if (thinkingBudget !== null) {
    // "adaptive" may not be in this SDK version's discriminated union —
    // cast through unknown to bypass the type checker.
    (params as unknown as Record<string, unknown>).thinking = { type: "adaptive" };
    // Do NOT set temperature — it is rejected by Opus 4.7+ when thinking is enabled.
  }

  const response = await anthropic.messages.create(params);
  for (const block of response.content) {
    if (block.type === "text") return block.text.trim();
  }
  return "";
}

// ─── extractJson ─────────────────────────────────────────────────────────────
//
// Pull the first JSON object out of a model response. Tolerates markdown fences
// and preamble text. Returns null when no valid JSON object is found.

export function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
