import { config } from "../config.js";
import { llmCall } from "../services/llm-call.js";
import { getClassifierPrompt } from "./prompts.js";
import { isDomain, type Routing } from "./types.js";

// JSON-mode classifier. We could use tool_use, but with Claude 4.x the
// strict JSON schema in the system prompt + a parse fallback is reliable
// at this prompt size, ~10x cheaper to debug, and keeps the LlmProvider
// interface lean (no tool_use abstraction needed at the provider layer).
//
// System prompt lives in prompts/classifier.md so we can iterate on it
// without redeploying code.
export async function classify(
  message: string,
  ctx: { athleteId?: string; messageId?: string },
): Promise<Routing> {
  const res = await llmCall(
    {
      model: config.llm.classifierModel,
      system: getClassifierPrompt(),
      user: message,
      maxTokens: 200,
      temperature: 0,
      cacheSystem: true,
    },
    { athleteId: ctx.athleteId, messageId: ctx.messageId, component: "classifier" },
  );
  return parseRouting(res.text);
}

// Defensive parse — the classifier is instructed to emit one-line JSON but
// LLMs occasionally wrap in markdown or add a stray paragraph. Strip
// fences and take the first JSON object we find.
export function parseRouting(raw: string): Routing {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`classifier returned non-JSON response: ${raw.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new Error(
      `classifier JSON parse failed: ${(err as Error).message} — raw: ${raw.slice(0, 200)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("classifier JSON was not an object");
  }
  const obj = parsed as Record<string, unknown>;
  const rawDomains = obj.domains;
  if (!Array.isArray(rawDomains) || rawDomains.length === 0) {
    throw new Error("classifier produced empty domains list");
  }
  const domains = rawDomains.filter(
    (d): d is string => typeof d === "string" && isDomain(d),
  );
  if (domains.length === 0) {
    throw new Error(
      `classifier produced no recognised domains (got ${rawDomains.join(",")})`,
    );
  }
  const confidence =
    typeof obj.confidence === "number" ? obj.confidence : 0.5;
  const rationale =
    typeof obj.rationale === "string" ? obj.rationale : "";
  // ET5: new fields. Default to safe values when the LLM doesn't emit
  // them (e.g. older prompts in flight during a deploy) — isFork false
  // means the rest of the pipeline runs unchanged, resolvesDecision null
  // means we defer to the binder.
  const isFork = obj.is_fork === true;
  const resolvesDecision =
    typeof obj.resolves_decision === "string" && obj.resolves_decision.length > 0
      ? obj.resolves_decision
      : null;
  // De-dupe while preserving order.
  const seen = new Set<string>();
  const unique = domains.filter((d) =>
    seen.has(d) ? false : (seen.add(d), true),
  );
  return {
    domains: unique as Routing["domains"],
    confidence,
    rationale,
    isFork,
    resolvesDecision,
  };
}
