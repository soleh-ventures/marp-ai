import { config } from "../config.js";
import { llmCall } from "../services/llm-call.js";
import { DOMAINS, isDomain, type Routing } from "./types.js";

// JSON-mode classifier. We could use tool_use, but with Claude 4.x the
// strict JSON schema in the system prompt + a parse fallback is reliable
// at this prompt size, ~10x cheaper to debug, and keeps the LlmProvider
// interface lean (no tool_use abstraction needed at the provider layer).
const SYSTEM = `You are MARP's routing classifier. The runner's message will be
handled by one or more domain experts: training, nutrition, injury, mental,
recovery, gear.

Pick the MINIMUM set of domains needed. Most messages need exactly one. Only
return multiple domains when the message genuinely spans them — e.g. "my
shin hurts and I'm freaking out about the race" is injury + mental, but
"how do I taper?" is training only.

Respond with STRICT JSON on a single line, no prose, no markdown fences:
{"domains":["training"],"confidence":0.92,"rationale":"asks about taper week structure"}

Allowed domains: ${DOMAINS.join(", ")}.
Confidence is your own 0..1 estimate. Rationale is one short sentence.`;

export async function classify(
  message: string,
  ctx: { athleteId?: string; messageId?: string },
): Promise<Routing> {
  const res = await llmCall(
    {
      model: config.llm.classifierModel,
      system: SYSTEM,
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
  // De-dupe while preserving order.
  const seen = new Set<string>();
  const unique = domains.filter((d) =>
    seen.has(d) ? false : (seen.add(d), true),
  );
  return {
    domains: unique as Routing["domains"],
    confidence,
    rationale,
  };
}
