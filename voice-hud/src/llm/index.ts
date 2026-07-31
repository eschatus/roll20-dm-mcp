// Provider factory — the ONE place that maps config → a concrete LLMProvider.
// Add a backend by implementing LLMProvider and adding a case here; agent.ts is
// untouched.

import { LLMProvider } from "./provider";
import { OllamaProvider } from "./ollama";
import { OllamaNativeProvider } from "./ollama-native";
import { AnthropicProvider } from "./anthropic";
import { CONFIG } from "../config";

export { LLMProvider, LLMTurn, ToolSpec, ToolCall } from "./provider";
export { OllamaNativeProvider } from "./ollama-native";

export type ProviderName = "ollama" | "anthropic";

export function createProvider(name: ProviderName = CONFIG.provider): LLMProvider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider(CONFIG.model);
    case "ollama":
    default:
      // DMW_OLLAMA_NATIVE=1 swaps the OpenAI-compat /v1 shim for Ollama's own
      // /api/chat — the /v1 endpoint silently ignores `options` (num_ctx) and has
      // no `format` (JSON-schema-constrained decoding) knob at all. See
      // llm/ollama-native.ts for why this matters for DMW_CONSTRAIN_TOOLS.
      return process.env.DMW_OLLAMA_NATIVE === "1"
        ? new OllamaNativeProvider(CONFIG.ollamaModel, CONFIG.ollamaNativeUrl)
        : new OllamaProvider(CONFIG.ollamaModel, CONFIG.ollamaUrl);
  }
}
