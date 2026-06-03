// Per-million-token prices in USD. Used to estimate cost on every call so
// llm_calls.cost_estimate_usd has signal from day 1 (E13).
//
// Verify against https://www.anthropic.com/pricing before launch — these
// numbers are placeholders representative of the Claude 4.x family.
type Price = { inputPerM: number; outputPerM: number };

const PRICES: Record<string, Price> = {
  // Haiku tier — cheap + fast. Classifier and short utility calls.
  "claude-haiku-4-5": { inputPerM: 1.0, outputPerM: 5.0 },
  "claude-haiku-4-5-20251001": { inputPerM: 1.0, outputPerM: 5.0 },
  // Sonnet tier — default for domain answers + synthesizer.
  "claude-sonnet-4-6": { inputPerM: 3.0, outputPerM: 15.0 },
  // Opus tier — reserved for the rare case where we need top quality.
  "claude-opus-4-7": { inputPerM: 15.0, outputPerM: 75.0 },
  // Mock provider — zero cost.
  mock: { inputPerM: 0, outputPerM: 0 },
};

// Anthropic prompt-cache pricing multipliers, applied per-token:
//   regular input: 1.0x
//   cache-read:    0.10x (90% off)
//   cache-create:  1.25x (one-time, 25% premium)
//
// We don't track cache_create separately for cost — it's a one-time
// hit per prompt edit, rare in production, and treating it as regular
// input is a tiny under-estimate (~25% extra on the first call after
// each prompt change). Cache-read, by contrast, fires on EVERY
// subsequent call to the same prompt — that's where the 70% cost
// savings actually live, and where accurate accounting matters.
const CACHE_READ_MULTIPLIER = 0.10;

export function estimateCostUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
  cacheReadTokens: number = 0,
): number {
  const p = PRICES[model];
  if (!p) {
    // Unknown model — return 0 rather than throw so a typo doesn't kill the
    // request path. The dashboard will surface "unknown model" rows so we
    // notice when prices haven't been added.
    return 0;
  }
  // Split tokensIn into the regular and cache-read portions.
  // cacheReadTokens > tokensIn shouldn't happen (the provider sums them
  // for tokensIn), but clamp defensively so a bad upstream value can't
  // produce a negative cost.
  const cacheRead = Math.min(Math.max(cacheReadTokens, 0), tokensIn);
  const regularIn = tokensIn - cacheRead;
  return (
    (regularIn / 1_000_000) * p.inputPerM +
    (cacheRead / 1_000_000) * p.inputPerM * CACHE_READ_MULTIPLIER +
    (tokensOut / 1_000_000) * p.outputPerM
  );
}
