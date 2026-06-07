// S1 (KER-29) — safety triage classifier.
//
// Runs on EVERY inbound message, BEFORE onboarding / routing, so a
// coaching reply can never be served when the runner is describing a
// medical emergency or a red-flag health situation. Deliberately the
// OPPOSITE of flag-detector: that one is strict (false positives pollute
// memory); this one biases toward catching (a missed emergency is the
// worst outcome in the product).
//
// Tier 0 ("emergency") → process-incoming short-circuits to a scripted,
// region-aware response + operator alert. Tier 1 ("referral") → the
// normal reply is built but a hard referral is prepended.
//
// Haiku (classifierModel) — cheap + fast, runs on the hot path. On any
// parse/LLM failure we fail to "none" (don't block coaching) but log
// loudly; one retry first, mirroring the router classifier.

import { config } from "../../config.js";
import { getSafetyTriagePrompt } from "../../router/prompts.js";
import { llmCall } from "../llm-call.js";
import { combineTriage, screenDeterministic } from "./deterministic.js";

export type SafetyTier = "emergency" | "referral" | "none";

export type SafetyTriage = {
  tier: SafetyTier;
  category: string;
  reason: string;
};

const SAFE_DEFAULT: SafetyTriage = { tier: "none", category: "none", reason: "" };

export async function triageSafety(
  message: string,
  ctx: { athleteId?: string; messageId?: string },
): Promise<SafetyTriage> {
  if (!message.trim()) return SAFE_DEFAULT;

  // Layer 1 — deterministic floor. Runs with no LLM, so it holds even if
  // the model below is wrong or unavailable. Can only escalate the tier.
  const floor = screenDeterministic(message);

  // Review (adversarial): if the floor already caught an emergency, skip
  // the LLM entirely — the runner is in crisis and must get the help line
  // with zero LLM latency, and the LLM can't escalate past "emergency"
  // anyway. (Also saves the Haiku call on the clearest cases.)
  if (floor.tier === "emergency") return floor;

  // Layer 2 — the LLM classifier adds recall on top. One retry, then we
  // fall back to the deterministic floor (NOT to "none") so a failing
  // classifier can never strip the guardrail on a clear crisis message.
  let llmResult: SafetyTriage = SAFE_DEFAULT;
  let llmOk = false;
  for (let attempt = 0; attempt < 2 && !llmOk; attempt++) {
    try {
      const res = await llmCall(
        {
          model: config.llm.classifierModel,
          system: getSafetyTriagePrompt(),
          user: message,
          maxTokens: 120,
          temperature: 0,
          cacheSystem: true,
        },
        {
          athleteId: ctx.athleteId,
          messageId: ctx.messageId,
          component: "classifier",
        },
      );
      llmResult = parseTriage(res.text);
      llmOk = true;
    } catch (err) {
      console.error(
        `safety-triage: LLM attempt ${attempt + 1}/2 failed:`,
        (err as Error).message,
      );
    }
  }
  if (!llmOk) {
    console.error(
      `safety-triage: LLM failed twice; relying on deterministic floor (tier=${floor.tier})`,
    );
  }

  // Take the higher severity of the two layers.
  return combineTriage(floor, llmResult);
}

const VALID_TIERS: ReadonlySet<string> = new Set([
  "emergency",
  "referral",
  "none",
]);

// Defensive parse — same shape as classifier/binder. Throws are caught by
// the caller's retry loop; a structurally-bad-but-parseable object falls
// back to "none" rather than crashing the message.
export function parseTriage(raw: string): SafetyTriage {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`safety-triage: non-JSON response: ${raw.slice(0, 160)}`);
  }
  const obj = JSON.parse(match[0]) as Record<string, unknown>;
  const tier = typeof obj.tier === "string" && VALID_TIERS.has(obj.tier)
    ? (obj.tier as SafetyTier)
    : "none";
  const category = typeof obj.category === "string" ? obj.category : "none";
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  return { tier, category, reason };
}
