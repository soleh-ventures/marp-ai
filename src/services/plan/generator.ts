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

import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { athletes } from "../../db/schema.js";
import { getMemoryContext } from "../../memory/retrieve.js";
import { getPlanGeneratorPrompt } from "../../router/prompts.js";
import { llmCall } from "../llm-call.js";
import { nextMonday, nowInZone } from "../reminders/timezone.js";
import { parsePlan, type Plan } from "./types.js";

export type GeneratePlanInput = {
  athleteId: string;
  messageId: string;
};

export async function generatePlan(input: GeneratePlanInput): Promise<Plan> {
  const memory = await getMemoryContext(input.athleteId);

  // F8 (v1.2): resolve the runner's local frame so "today" + the weekday
  // are correct and the model never derives the weekday itself. Timezone
  // may be null pre-plan, so we fall back to phone-code inference.
  const [row] = await db
    .select({ phone: athletes.phone, timezone: athletes.timezone })
    .from(athletes)
    .where(eq(athletes.id, input.athleteId))
    .limit(1);
  const phone = row?.phone ?? "";
  const zoned = nowInZone(row?.timezone, phone);
  // Compute week-1's Monday in code — the LLM is unreliable at date math.
  const startDate = nextMonday(row?.timezone, phone);

  const userPayload =
    `# Today's date\n${zoned.date} (${zoned.weekday})\n\n` +
    `# Week 1 start_date (use EXACTLY this — it is the next Monday)\n${startDate}\n\n` +
    `# Athlete context\n${memory.text}\n\n` +
    `# Task\nBuild a complete periodised plan for this runner. Return ONLY the JSON described in your instructions — no markdown, no commentary.`;

  // A full 16-week periodised plan (up to 7 sessions/week, each with a
  // description + reasoning line) runs well past 4000 output tokens — the
  // old cap truncated the JSON mid-array, parsePlanResponse threw, and the
  // runner saw "couldn't build the plan this turn". 16000 comfortably fits
  // the longest plan the prompt will produce (capped at 16 weeks). We only
  // pay for tokens actually emitted, so the headroom is free.
  const callOnce = () =>
    llmCall(
      {
        model: config.llm.domainModel,
        system: getPlanGeneratorPrompt(),
        user: userPayload,
        maxTokens: 16000,
        temperature: 0.4,
        cacheSystem: true,
      },
      { athleteId: input.athleteId, messageId: input.messageId, component: "domain" },
    );

  // One-shot retry: a malformed/truncated first response is usually
  // transient (a stray prose preamble, an over-long week). Re-asking once
  // recovers far more often than not, and keeps the runner from hitting the
  // generic failure message on a recoverable blip. Bounded at 1 for
  // predictable latency/cost.
  let plan: Plan;
  try {
    plan = parsePlanResponse((await callOnce()).text);
  } catch (firstErr) {
    console.error(
      "plan-generator: first attempt failed, retrying once:",
      (firstErr as Error).message,
    );
    plan = parsePlanResponse((await callOnce()).text);
  }

  // Authoritative override — the start_date is computed in code, not
  // trusted from the LLM. Keeps week-1 anchored to the real next Monday.
  plan.start_date = startDate;
  return plan;
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
