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

export function estimateCostUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const p = PRICES[model];
  if (!p) {
    // Unknown model — return 0 rather than throw so a typo doesn't kill the
    // request path. The dashboard will surface "unknown model" rows so we
    // notice when prices haven't been added.
    return 0;
  }
  return (
    (tokensIn / 1_000_000) * p.inputPerM +
    (tokensOut / 1_000_000) * p.outputPerM
  );
}
