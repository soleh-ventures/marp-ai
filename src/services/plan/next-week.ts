// Adaptive next-week menu generator.
//
// An onboarded runner mid-training asks "what's my menu for next week?" — they
// want a SHORT upcoming week shaped by how they've actually been running, not a
// fresh 16-week periodised plan from week 1. This reads their recent (deduped
// Garmin) performance + recovery + goal and emits ONE upcoming week.
//
// Output goes through the same parsePlanResponse()/parsePlan() as the full
// generator, so it's a valid stored Plan (one week) — getStoredPlan(),
// weekly-eval, plan edits and the calendar feed all keep working. Regenerating
// next week rolls it forward.

import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { athletes } from "../../db/schema.js";
import { getMemoryContext } from "../../memory/retrieve.js";
import { getNextWeekPlanPrompt } from "../../router/prompts.js";
import { llmCall } from "../llm-call.js";
import { nextMonday, nowInZone } from "../reminders/timezone.js";
import { parsePlanResponse } from "./generator.js";
import { type Plan } from "./types.js";

export type NextWeekPlanInput = {
  athleteId: string;
  messageId: string | null;
  // The runner's actual message ("make it easier", "add hills", "I feel wrecked
  // this week", "I'm racing in 3 weeks"). Without this the week is generated
  // purely from stored context, so every request returns the SAME plan — the
  // exact "no matter my input, same plan" bug. Honoured inside the safety rules.
  requestText?: string | null;
};

// Does this message ask for the UPCOMING week's training (not a review of the
// past week — that's looksLikeWeekReviewRequest)? Catches "plan/menu for next
// week", "build a training plan for next week", "what should I run next week",
// "this week's menu". Deliberately requires both a future-week reference and a
// planning intent so it doesn't swallow generic coaching questions.
export function looksLikeNextWeekPlanRequest(body: string): boolean {
  const t = body.toLowerCase();
  const futureWeek =
    /\b(next|coming|upcoming|following)\s+week\b/.test(t) ||
    /\b(this|the)\s+week['’]?s?\s+(plan|menu|training|schedule|workout|program|routine)\b/.test(t) ||
    /\b(plan|menu|training|schedule|workout|program|routine)\s+for\s+(next|this|the|coming|upcoming)\s+week\b/.test(t);
  if (!futureWeek) return false;
  const planIntent =
    /\b(plan|menu|training|schedule|workout|session|program|routine|prep|build|create|make|give|design)\b/.test(t) ||
    /\bwhat\s+(should|shall|do)\s+i\s+(do|run|train)\b/.test(t);
  return planIntent;
}

export async function generateNextWeekPlan(input: NextWeekPlanInput): Promise<Plan> {
  const memory = await getMemoryContext(input.athleteId);

  const [row] = await db
    .select({ phone: athletes.phone, timezone: athletes.timezone })
    .from(athletes)
    .where(eq(athletes.id, input.athleteId))
    .limit(1);
  const phone = row?.phone ?? "";
  const zoned = nowInZone(row?.timezone, phone);
  // Upcoming Monday computed in code — the LLM is unreliable at date math.
  const startDate = nextMonday(row?.timezone, phone);

  const request = (input.requestText ?? "").trim();
  const requestBlock = request
    ? `# What the runner asked for THIS week (their exact words — honour it within the safety rules; it overrides your default read)\n${request}\n\n`
    : "";

  const userPayload =
    `# Today's date\n${zoned.date} (${zoned.weekday})\n\n` +
    `# Upcoming week start_date (use EXACTLY this — the next Monday)\n${startDate}\n\n` +
    requestBlock +
    `# Athlete context (recent training is Garmin — already deduped, source of truth)\n${memory.text}\n\n` +
    `# Task\nRead this runner's RECENT performance and condition AND what they asked for above, then design ONE upcoming week (a single week in the weeks array) that is the smart next step from where they are and reflects their request. Return ONLY the JSON described in your instructions — no markdown, no commentary.`;

  const callOnce = () =>
    llmCall(
      {
        // Weekly adaptation uses the domain model (cheaper than the full-plan
        // creation model); it's one week, not a 16-week periodisation.
        model: config.llm.domainModel,
        system: getNextWeekPlanPrompt(),
        user: userPayload,
        maxTokens: 3000,
        temperature: 0.4,
        cacheSystem: true,
      },
      { athleteId: input.athleteId, messageId: input.messageId ?? undefined, component: "domain" },
    );

  // One-shot retry — a truncated/prose-wrapped first response usually recovers.
  let plan: Plan;
  try {
    plan = parsePlanResponse((await callOnce()).text);
  } catch (firstErr) {
    console.error(
      "next-week-plan: first attempt failed, retrying once:",
      (firstErr as Error).message,
    );
    plan = parsePlanResponse((await callOnce()).text);
  }

  // Authoritative overrides: anchor the start to the real Monday, and keep it to
  // a SINGLE upcoming week even if the model over-produces.
  plan.start_date = startDate;
  if (plan.weeks.length > 1) plan.weeks = plan.weeks.slice(0, 1);
  return plan;
}
