// One-shot text completion against a chat model. Kept minimal so we can swap
// providers (Anthropic, OpenAI, mock) without leaking SDK shapes into the
// router. Tool use is intentionally not exposed at this layer — the
// classifier uses a JSON-output convention via the system prompt + a strict
// schema check at the call site. If we add real tool_use, add a second
// method here (callTool) rather than overloading callText.

export type LlmRequest = {
  model: string;
  system: string;
  user: string;
  // Hard cap on output tokens — Anthropic requires this. Keep low for
  // classifier (~50), higher for domain answers (~1500), highest for
  // synthesizer (~2000).
  maxTokens: number;
  // 0 for classifier (deterministic routing), ~0.6 for domain answers.
  temperature?: number;
  // When true, Anthropic SDK adds cache_control to the system prompt so
  // repeated long prompts (domains, synthesizer) hit the cache. T6 will
  // turn this on for the real domain .md files.
  cacheSystem?: boolean;
};

export type LlmResponse = {
  text: string;
  tokensIn: number;
  tokensOut: number;
  // Wall-clock latency from request send to response received, in ms.
  latencyMs: number;
  // True when this call's input was served (mostly) from the prompt cache.
  // Currently informational — useful for verifying caching actually fires
  // in prod logs.
  cacheHit: boolean;
};

export interface LlmProvider {
  readonly name: "anthropic" | "mock";
  callText(req: LlmRequest): Promise<LlmResponse>;
}
