import { config } from "../../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { mockProvider } from "./mock.js";
import type { LlmProvider } from "./types.js";

// Lazily constructed so tests that hard-set LLM_PROVIDER=mock don't trip
// the "ANTHROPIC_API_KEY is not set" guard at import time.
let cached: LlmProvider | undefined;

export function getProvider(): LlmProvider {
  if (cached) return cached;
  cached = config.llm.provider === "mock" ? mockProvider : new AnthropicProvider();
  return cached;
}

export function _resetProviderCache(): void {
  cached = undefined;
}

export { mockProvider };
export type { LlmProvider, LlmRequest, LlmResponse } from "./types.js";
