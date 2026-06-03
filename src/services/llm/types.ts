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
  // Total input tokens consumed = fresh + cacheRead + cacheCreate. Keep
  // this as the "what was the volume" figure for analytics; cost math
  // splits it back out via the breakdown below.
  tokensIn: number;
  tokensOut: number;
  // Subset of tokensIn that was served from the prompt cache. Anthropic
  // bills these at 10% of the base input rate, so pricing must split
  // them out — otherwise we'd over-report cost by ~3-5x once caching
  // kicks in on the long domain / synthesizer prompts.
  cacheReadTokens: number;
  // Subset of tokensIn that wrote a new cache entry (first call to a
  // freshly-edited prompt, or after a 5-minute idle expiry). Anthropic
  // bills these at 125% of the base rate. Kept separate for accurate
  // cost telemetry; treated as regular input cost in v1 pricing math
  // (slight under-estimate — the worst case is one over-priced cache
  // creation per prompt edit, which is rare).
  cacheCreateTokens: number;
  // Wall-clock latency from request send to response received, in ms.
  latencyMs: number;
  // Convenience: true when this call's input was served (mostly) from
  // the prompt cache. Equivalent to cacheReadTokens > cacheCreateTokens.
  // Surfaced separately so analytics can do COUNT(*) WHERE cache_hit
  // without needing the breakdown.
  cacheHit: boolean;
};

export interface LlmProvider {
  readonly name: "anthropic" | "mock";
  callText(req: LlmRequest): Promise<LlmResponse>;
}
