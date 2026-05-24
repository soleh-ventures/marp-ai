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
  | "other";

export type CallContext = {
  athleteId?: string;
  messageId?: string;
  component: LlmComponent;
};

// Every LLM call in the app goes through this wrapper. It exists for one
// reason: E13 — log model, tokens, cost, latency into llm_calls so we can
// answer "what does a runner cost per week" from day 1. Skipping this
// wrapper is a bug.
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
    costEstimateUsd: estimateCostUsd(req.model, res.tokensIn, res.tokensOut),
    latencyMs: res.latencyMs,
  });
  return res;
}
