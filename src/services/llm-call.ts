import { db } from "../db/client.js";
import { llmCalls } from "../db/schema.js";
import { getProvider } from "./llm/index.js";
import { estimateCostUsd } from "./llm/pricing.js";
import type { LlmRequest, LlmResponse } from "./llm/types.js";

// Component values must match the llm_component pg enum. Keep this in
// sync with src/db/schema.ts.
export type LlmComponent =
  | "classifier"
  | "domain"
  | "synthesizer"
  | "memory"
  | "content"
  // ET2: binder runs after every free-form reply to resolve pending
  // decision frames. Kept separate so its cost is visible per-component.
  | "binder"
  | "other";

export type CallContext = {
  athleteId?: string;
  messageId?: string;
  component: LlmComponent;
};

// Hard cap on the I/O text we persist per row. Bounds row size against a
// pathological payload (a runner pasting a huge plan, a runaway reply).
// The dynamic context that matters for debugging fits comfortably under
// this; anything past it is logged truncated with a marker.
const IO_TEXT_CAP = 100_000;

function capText(s: string): string {
  return s.length > IO_TEXT_CAP
    ? `${s.slice(0, IO_TEXT_CAP)}…[truncated ${s.length - IO_TEXT_CAP} chars]`
    : s;
}

// Every LLM call in the app goes through this wrapper. It exists for one
// reason: E13 — log model, tokens, cost, latency into llm_calls so we can
// answer "what does a runner cost per week" from day 1. Skipping this
// wrapper is a bug.
//
// It also captures input_user + output_text so a bad reply can be traced
// to what produced it. These hold PII (runner context, health detail), so
// athlete erasure NULLs them — see erasure.ts.
export async function llmCall(
  req: LlmRequest,
  ctx: CallContext,
): Promise<LlmResponse> {
  const provider = getProvider();
  const res = await provider.callText(req);
  await db.insert(llmCalls).values({
    athleteId: ctx.athleteId ?? null,
    messageId: ctx.messageId ?? null,
    component: ctx.component,
    model: req.model,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
    inputUser: capText(req.user),
    outputText: capText(res.text),
    // T6: persist the cache telemetry so we can verify caching is firing
    // in prod (SELECT count(*) FROM llm_calls WHERE cache_hit) and so the
    // cost estimate reflects the 10% rate on cache-read tokens.
    cacheHit: res.cacheHit,
    cacheReadTokens: res.cacheReadTokens,
    costEstimateUsd: estimateCostUsd(
      req.model,
      res.tokensIn,
      res.tokensOut,
      res.cacheReadTokens,
    ),
    latencyMs: res.latencyMs,
  });
  return res;
}
