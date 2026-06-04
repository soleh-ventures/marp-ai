// V6 (v1.1 flow redesign) — plan generator.
//
// Single-shot LLM call that takes the athlete's profile + memory
// context and emits a full periodised plan. V6.0 ships single-shot;
// V6.1 will introduce the 3-tier pyramid commit pattern (macro →
// weekly → daily) once we have signal that the single-shot output
// quality is high enough not to need mid-flight runner intervention.
//
// Output goes through parsePlan() — malformed LLM output throws,
// caller is responsible for fallback messaging.

import { config } from "../../config.js";
import { getMemoryContext } from "../../memory/retrieve.js";
import { getPlanGeneratorPrompt } from "../../router/prompts.js";
import { llmCall } from "../llm-call.js";
import { parsePlan, type Plan } from "./types.js";

export type GeneratePlanInput = {
  athleteId: string;
  messageId: string;
};

export async function generatePlan(input: GeneratePlanInput): Promise<Plan> {
  const memory = await getMemoryContext(input.athleteId);

  const today = new Date().toISOString().slice(0, 10);
  const userPayload =
    `# Today's date\n${today}\n\n` +
    `# Athlete context\n${memory.text}\n\n` +
    `# Task\nBuild a complete periodised plan for this runner. Return ONLY the JSON described in your instructions — no markdown, no commentary.`;

  const res = await llmCall(
    {
      model: config.llm.domainModel,
      system: getPlanGeneratorPrompt(),
      user: userPayload,
      maxTokens: 4000,
      temperature: 0.4,
      cacheSystem: true,
    },
    { athleteId: input.athleteId, messageId: input.messageId, component: "domain" },
  );

  return parsePlanResponse(res.text);
}

// Extracts the JSON object from a raw LLM response. Tolerates the LLM
// wrapping the JSON in markdown fences (which it occasionally does
// despite the prompt saying not to).
export function parsePlanResponse(raw: string): Plan {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`plan-generator: non-JSON response: ${raw.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new Error(
      `plan-generator: JSON parse failed: ${(err as Error).message} — raw: ${raw.slice(0, 200)}`,
    );
  }
  return parsePlan(parsed);
}
