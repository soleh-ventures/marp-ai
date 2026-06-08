// KER-79 (Grounded Coach, Phase 2) — end-of-week coach evaluation.
//
// A real coach doesn't just react; at the end of the week they tell you how
// it went — the result, what went well, what to sharpen — and decide whether
// next week should change. This builds that evaluation, grounded in the
// DETERMINISTIC adherence facts (adherence.ts) plus M1's physiological week
// signals (run-retro), then an LLM writes the coach-to-athlete read and a
// holistic adjust/hold decision.
//
// Two consumers:
//   - reactive (live now): the runner asks "how did my week go?" → we return
//     the evaluation message (read-only; we don't mutate the plan on a read).
//   - proactive (gated, wired onto the weekly sweep): MARP sends it at end of
//     week and, when it decides next week needs changing, applies the edit and
//     tells them (with a one-tap revert). Health red flags set safety_hold and
//     are proposed, never auto-applied.

import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../db/client.js";
import { activities, athletes } from "../db/schema.js";
import { getAthleticHistory } from "../flows/onboarding.js";
import { getWeeklyEvaluationPrompt } from "../router/prompts.js";
import { config } from "../config.js";
import { llmCall } from "./llm-call.js";
import {
  computeWeekAdherence,
  currentWeekIndex,
  renderAdherenceLine,
  type AdherenceActivity,
} from "./plan/adherence.js";
import { getStoredPlan } from "./plan/storage.js";
import { renderPlanForContext, type Plan } from "./plan/types.js";
import { resolveGoalLine } from "../memory/retrieve.js";
import {
  computeWeekSignals,
  loadWeekRows,
  openFlags,
  summarizeFeeling,
} from "./run-retro.js";
import { nowInZone } from "./reminders/timezone.js";

export type WeeklyEvaluationDecision = {
  adjust: boolean;
  safetyHold: boolean;
  changeSummary: string;
  rationale: string;
  editRequest: string;
};

export type WeeklyEvaluation = {
  message: string; // runner-facing coach evaluation
  decision: WeeklyEvaluationDecision;
  weekIndex: number;
};

// Defensive parse — mirrors the other extractors, never throws. Requires a
// non-empty evaluation string; everything else defaults safe (no adjust).
export function parseEvaluation(raw: string): WeeklyEvaluation["decision"] & {
  evaluation: string;
} {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  const fallback = {
    evaluation: "",
    adjust: false,
    safetyHold: false,
    changeSummary: "",
    rationale: "",
    editRequest: "",
  };
  if (!match) return fallback;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return fallback;
  }
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    evaluation: str(o.evaluation),
    adjust: o.adjust === true,
    safetyHold: o.safety_hold === true,
    changeSummary: str(o.change_summary),
    rationale: str(o.rationale),
    editRequest: str(o.edit_request),
  };
}

async function loadActivities(athleteId: string): Promise<AdherenceActivity[]> {
  // 21 days covers the week being evaluated with margin.
  const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
  return db
    .select({
      discipline: activities.discipline,
      startedAt: activities.startedAt,
      durationS: activities.durationS,
      metrics: activities.metrics,
    })
    .from(activities)
    .where(and(eq(activities.athleteId, athleteId), gte(activities.startedAt, since)))
    .orderBy(desc(activities.startedAt));
}

// Build the coach evaluation for a given week (defaults to the current week).
// Returns null when there's no plan to evaluate against — the caller falls
// back to normal routing. Pure of side effects: it never mutates the plan.
export async function buildWeeklyEvaluation(
  athleteId: string,
  opts: { messageId?: string; weekIndex?: number } = {},
): Promise<WeeklyEvaluation | null> {
  const [a] = await db
    .select({
      timezone: athletes.timezone,
      phone: athletes.phone,
      athleticHistory: athletes.athleticHistory,
    })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  if (!a) return null;

  const history = getAthleticHistory(a.athleticHistory);
  const plan: Plan | null = getStoredPlan(history);
  if (!plan) return null; // nothing to evaluate

  const today = nowInZone(a.timezone, a.phone).date;
  const weekIndex = opts.weekIndex ?? currentWeekIndex(plan, today);

  const acts = await loadActivities(athleteId);
  const adherence = computeWeekAdherence(plan, weekIndex, acts, today);
  const adherenceLine = renderAdherenceLine(adherence) ?? "No prescribed sessions were due this week.";

  const rows = await loadWeekRows(athleteId);
  const flags = await openFlags(athleteId);
  const signals = computeWeekSignals(rows, flags.length > 0);
  const perRun = rows.map((r) => summarizeFeeling(r.feeling)).filter((s) => s !== "(no feeling)");

  const goalLine = resolveGoalLine(undefined, a.athleticHistory) ?? "Goal: not on file.";

  const payload = [
    `Today: ${today}. Evaluating week ${weekIndex} of ${plan.weeks.length}.`,
    goalLine,
    plan.race_date ? `Race date: ${plan.race_date}.` : "No race date on file.",
    "",
    "ADHERENCE (ground truth — prescribed vs actual):",
    adherenceLine,
    "",
    "PHYSIOLOGICAL SIGNALS this week:",
    JSON.stringify(signals),
    perRun.length ? `Per-run feel: ${perRun.join(" | ")}` : "Per-run feel: (none logged)",
    flags.length ? `Open flags: ${flags.map((f) => `${f.kind}: ${f.body}`).join("; ")}` : "Open flags: none",
    "",
    "CURRENT PLAN (for context on what next week looks like):",
    renderPlanForContext(plan),
  ].join("\n");

  let text: string;
  try {
    const res = await llmCall(
      {
        model: config.llm.planModel,
        system: getWeeklyEvaluationPrompt(),
        user: payload,
        maxTokens: 700,
        temperature: 0.4,
      },
      { athleteId, messageId: opts.messageId, component: "domain" },
    );
    text = res.text;
  } catch (err) {
    console.error("weekly-evaluation: LLM failed:", (err as Error).message);
    return null;
  }

  const parsed = parseEvaluation(text);
  if (!parsed.evaluation) return null;

  return {
    message: parsed.evaluation,
    weekIndex,
    decision: {
      adjust: parsed.adjust,
      safetyHold: parsed.safetyHold,
      changeSummary: parsed.changeSummary,
      rationale: parsed.rationale,
      editRequest: parsed.editRequest,
    },
  };
}

// Cheap pure pre-check for the reactive path: is the runner asking for a
// weekly evaluation / recap? Kept narrow so it doesn't swallow coaching Qs.
const WEEK_REVIEW_Q =
  /\b(how(?:'?s| is| did| was) (my|this|the) week (gone|going|go|been)?|evaluate (my|this) week|weekly (review|recap|summary|evaluation)|how did i do this week|review my week|how was my (training )?week)\b/i;

export function looksLikeWeekReviewRequest(body: string): boolean {
  return WEEK_REVIEW_Q.test(body);
}
