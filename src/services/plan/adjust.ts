// v1.3 (A1) — plan adjustment via targeted mutation.
//
// The runner asks to change their existing plan ("move my long run to
// Saturday", "I can't run Wednesdays", "make week 3 easier"). Instead of
// regenerating from scratch (expensive, loses the rest of the plan) we
// send the CURRENT plan + the change to Sonnet and ask for the modified
// plan back. parsePlan validates it; the caller saves via saveAthletePlan
// (the same write path as generate/ingest).
//
// Model: domainModel (Sonnet) — adjustments are smaller, more frequent,
// and lower-stakes than first creation (which runs on planModel/Opus).

import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { athletes } from "../../db/schema.js";
import { getAthleticHistory } from "../../flows/onboarding.js";
import { getPlanAdjustPrompt } from "../../router/prompts.js";
import { llmCall } from "../llm-call.js";
import { nowInZone } from "../reminders/timezone.js";
import { parsePlanResponse } from "./generator.js";
import { getStoredPlan } from "./storage.js";
import type { Plan } from "./types.js";

export type AdjustPlanInput = {
  athleteId: string;
  messageId: string;
  editRequest: string;
};

export type AdjustPlanResult =
  | { ok: true; plan: Plan }
  | { ok: false; reason: "no_plan" | "parse_failed" };

export async function adjustPlan(
  input: AdjustPlanInput,
): Promise<AdjustPlanResult> {
  const [row] = await db
    .select({
      phone: athletes.phone,
      timezone: athletes.timezone,
      athleticHistory: athletes.athleticHistory,
    })
    .from(athletes)
    .where(eq(athletes.id, input.athleteId))
    .limit(1);

  // Guard: no plan to edit yet. The caller turns this into a friendly
  // "let's build your plan first" nudge rather than a crash.
  const current = row ? getStoredPlan(getAthleticHistory(row.athleticHistory)) : null;
  if (!current) return { ok: false, reason: "no_plan" };

  const zoned = nowInZone(row?.timezone, row?.phone ?? "");

  const userPayload =
    `# Today's date\n${zoned.date} (${zoned.weekday})\n\n` +
    `# The runner's current plan (JSON)\n${JSON.stringify(current)}\n\n` +
    `# The change they asked for\n${input.editRequest}\n\n` +
    `# Task\nApply ONLY that change. Keep everything else exactly as it is — ` +
    `same start_date, same race, same untouched weeks and sessions and their ` +
    `reasoning. Return ONLY the full modified plan as JSON, no markdown, no commentary.`;

  const callOnce = () =>
    llmCall(
      {
        model: config.llm.domainModel,
        system: getPlanAdjustPrompt(),
        user: userPayload,
        maxTokens: 16000,
        temperature: 0.3,
        cacheSystem: true,
      },
      { athleteId: input.athleteId, messageId: input.messageId, component: "domain" },
    );

  // One-shot retry, same rationale as the generator: a malformed/truncated
  // first response is usually a transient blip that re-asking clears.
  let plan: Plan;
  try {
    plan = parsePlanResponse((await callOnce()).text);
  } catch (firstErr) {
    console.error(
      "plan-adjust: first attempt failed, retrying once:",
      (firstErr as Error).message,
    );
    try {
      plan = parsePlanResponse((await callOnce()).text);
    } catch (secondErr) {
      console.error("plan-adjust: retry also failed:", (secondErr as Error).message);
      return { ok: false, reason: "parse_failed" };
    }
  }

  // Preserve the original anchor — an edit must never silently move week 1.
  // The plan already started; start_date is not the model's to change.
  plan.start_date = current.start_date;
  return { ok: true, plan };
}
