// Provider factory — the ONE place that maps config → a concrete LLMProvider.
// Add a backend by implementing LLMProvider and adding a case here; agent.ts is
// untouched.

import { LLMProvider } from "./provider";
import { OllamaProvider } from "./ollama";
import { AnthropicProvider } from "./anthropic";
import { CONFIG } from "../config";

export { LLMProvider, LLMTurn, ToolSpec, ToolCall } from "./provider";

export type ProviderName = "ollama" | "anthropic";

export function createProvider(name: ProviderName = CONFIG.provider): LLMProvider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider(CONFIG.model);
    case "ollama":
    default:
      return new OllamaProvider(CONFIG.ollamaModel, CONFIG.ollamaUrl);
  }
}
