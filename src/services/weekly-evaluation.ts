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

import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { activities, athletes, weeklyEvaluations } from "../db/schema.js";
import { getAthleticHistory } from "../flows/onboarding.js";
import { getRecoveryContext } from "./athlete-readiness.js";
import { getWeeklyEvaluationPrompt } from "../router/prompts.js";
import { config } from "../config.js";
import { llmCall } from "./llm-call.js";
import {
  computeWeekAdherence,
  currentWeekIndex,
  localDay,
  renderAdherenceLine,
  type AdherenceActivity,
} from "./plan/adherence.js";
import { adjustPlan } from "./plan/adjust.js";
import { getStoredPlan, saveAthletePlan } from "./plan/storage.js";
import { loadStreamSummaries, renderStreamAnnotation } from "./strava-streams.js";
import { renderPlanForContext, type Plan } from "./plan/types.js";
import { resolveGoalLine } from "../memory/retrieve.js";
import {
  computeWeekSignals,
  computeWeekStart,
  loadWeekRows,
  openFlags,
  summarizeFeeling,
} from "./run-retro.js";
import { nowInZone } from "./reminders/timezone.js";
import { sendWhatsApp } from "./twilio-send.js";
import { deliver } from "./messaging/deliver.js";

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

type WeekActivity = AdherenceActivity & { id: string };

async function loadActivities(athleteId: string): Promise<WeekActivity[]> {
  // 21 days covers the week being evaluated with margin.
  const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
  return db
    .select({
      id: activities.id,
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

  const zoned = nowInZone(a.timezone, a.phone);
  const today = zoned.date;
  const acts = await loadActivities(athleteId);

  // Evaluate the week the runner most recently TRAINED in, not the week that
  // happens to contain `today`. A "how did my week go?" asked on a Monday (or
  // any early-week day) means the week that just finished — anchoring to the
  // latest activity's date gets that right, while the proactive Sunday sweep
  // lands on the same (finishing) week either way. Falls back to today's week
  // when there are no activities. (Found in dogfooding.)
  const anchorDate = acts[0] ? localDay(acts[0].startedAt, zoned.timezone) : today;
  const weekIndex = opts.weekIndex ?? currentWeekIndex(plan, anchorDate);

  const adherence = computeWeekAdherence(plan, weekIndex, acts, today, zoned.timezone);
  const adherenceLine = renderAdherenceLine(adherence) ?? "No prescribed sessions were due this week.";

  const rows = await loadWeekRows(athleteId);
  const flags = await openFlags(athleteId);
  const signals = computeWeekSignals(rows, flags.length > 0);
  const recovery = await getRecoveryContext(athleteId).catch(() => null);
  const perRun = rows.map((r) => summarizeFeeling(r.feeling)).filter((s) => s !== "(no feeling)");

  const goalLine = resolveGoalLine(undefined, a.athleticHistory) ?? "Goal: not on file.";

  // KER-80 (Phase 3): stream shapes for this week's activities (split pattern,
  // HR drift) so the evaluation can cite progression, not just averages.
  const inWeek = acts.filter(
    (x) => x.startedAt.toISOString().slice(0, 10) >= adherence.start && x.startedAt.toISOString().slice(0, 10) <= adherence.end,
  );
  const streamMap = await loadStreamSummaries(inWeek.map((x) => x.id));
  const streamLines = inWeek
    .map((x) => {
      const s = streamMap.get(x.id);
      const note = s ? renderStreamAnnotation(s) : "";
      return note ? `${x.startedAt.toISOString().slice(0, 10)} ${x.discipline}: ${note}` : null;
    })
    .filter((v): v is string => v !== null);

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
    streamLines.length ? `Stream shapes: ${streamLines.join(" | ")}` : "Stream shapes: (none)",
    flags.length ? `Open flags: ${flags.map((f) => `${f.kind}: ${f.body}`).join("; ")}` : "Open flags: none",
    recovery ? recovery : "Recovery & load: (no wearable data)",
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

// ─── Proactive end-of-week path (gated, launch-bound like M1's retro) ───────

export type WeeklyEvalRunResult =
  | { ran: false; reason: "already_done" | "no_plan" | "llm_failed" }
  | { ran: true; status: string; adjusted: boolean; sent: boolean };

// Run the evaluation for one athlete + week, idempotently. Builds the coach
// read, and — per the user's decision — if the coach decides next week should
// change AND it's not a health red flag, APPLIES the change and tells them
// (with a one-tap revert). Health red flags (safety_hold) are proposed, never
// auto-applied. Persists one weekly_evaluations row (the idempotency + revert
// ledger). Sends only when proactive outbound is enabled.
export async function runWeeklyEvaluationForAthlete(input: {
  athleteId: string;
  weekStart: string;
  messageId?: string;
}): Promise<WeeklyEvalRunResult> {
  const { athleteId, weekStart } = input;

  // Idempotency: one evaluation per athlete-week (collapses the Sunday ticks).
  const [existing] = await db
    .select({ id: weeklyEvaluations.id })
    .from(weeklyEvaluations)
    .where(
      and(eq(weeklyEvaluations.athleteId, athleteId), eq(weeklyEvaluations.weekStart, weekStart)),
    )
    .limit(1);
  if (existing) return { ran: false, reason: "already_done" };

  const ev = await buildWeeklyEvaluation(athleteId, { messageId: input.messageId });
  if (!ev) return { ran: false, reason: "no_plan" };

  const d = ev.decision;
  let message = ev.message;
  let status = "evaluated";
  let beforePlan: Plan | null = null;
  let afterPlan: Plan | null = null;
  // The athlete history to write back when applying (captured before the
  // mutation so the plan update + ledger insert can land in one transaction).
  let applyHistory: Record<string, unknown> | null = null;

  if (d.adjust && d.safetyHold) {
    // Health red flag — never auto-change load. Surface + propose.
    status = "proposed";
    if (d.changeSummary) {
      message += `\n\nI'd usually adjust next week (${d.changeSummary}), but this looks health-related — let's not change your training around it blind. Reply "yes, adjust" if you want me to, and please get it checked.`;
    }
  } else if (d.adjust && d.editRequest) {
    // Coach decides + applies. Load history once; snapshot the current plan so
    // "keep it" can revert. Bail before the LLM call if there's no plan to edit
    // (don't burn a Sonnet call we'd discard — review).
    const [row] = await db
      .select({ athleticHistory: athletes.athleticHistory })
      .from(athletes)
      .where(eq(athletes.id, athleteId))
      .limit(1);
    const hist = getAthleticHistory(row?.athleticHistory);
    beforePlan = getStoredPlan(hist);
    if (beforePlan) {
      const res = await adjustPlan({ athleteId, messageId: input.messageId ?? "", editRequest: d.editRequest });
      if (res.ok) {
        afterPlan = res.plan;
        applyHistory = { ...hist, plan: res.plan };
        status = "applied";
        message += `\n\nI've adjusted next week — ${d.changeSummary}. ${d.rationale} Reply "keep it as it was" if you'd rather I didn't.`;
      }
      // If the edit couldn't be applied, fall back to the evaluation alone.
    }
  }

  const ledgerValues = {
    athleteId,
    weekStart,
    weekIndex: ev.weekIndex,
    evaluation: ev.message,
    adjusted: status === "applied",
    safetyHold: d.safetyHold,
    changeSummary: d.changeSummary || null,
    rationale: d.rationale || null,
    beforePlan,
    afterPlan,
    status,
  };

  if (status === "applied" && applyHistory) {
    // Atomic: the plan mutation and the ledger row land together, so a crash
    // can't leave a changed plan with no revert/idempotency record (review).
    // A unique-index conflict here throws and rolls back the plan update — the
    // safe outcome under the (single-process) idempotency guard.
    await db.transaction(async (tx) => {
      await tx.update(athletes).set({ athleticHistory: applyHistory }).where(eq(athletes.id, athleteId));
      await tx.insert(weeklyEvaluations).values(ledgerValues);
    });
  } else {
    // No mutation — the ledger insert is the only write. onConflictDoNothing
    // makes the once-per-week guarantee hold even if two ticks ever overlap.
    await db.insert(weeklyEvaluations).values(ledgerValues).onConflictDoNothing();
  }

  // Send only when the prod number is live (gated, like M1's retro). The row
  // is recorded regardless so the loop is built + testable pre-launch.
  let sent = false;
  if (config.proactive.outboundEnabled) {
    const res = await deliver(athleteId, message);
    if (res) {
      await db
        .update(weeklyEvaluations)
        .set({ sentAt: new Date() })
        .where(and(eq(weeklyEvaluations.athleteId, athleteId), eq(weeklyEvaluations.weekStart, weekStart)));
      sent = true;
    }
  }

  return { ran: true, status, adjusted: status === "applied", sent };
}

export type WeeklyEvalSweepStats = { considered: number; eligible: number; ran: number };

// End-of-week sweep on the in-process tick. Evaluates each athlete on their
// local Sunday; idempotent per athlete-week.
export async function runWeeklyEvaluationSweep(opts: { now: Date }): Promise<WeeklyEvalSweepStats> {
  const stats: WeeklyEvalSweepStats = { considered: 0, eligible: 0, ran: 0 };
  const candidates = await db
    .select({ id: athletes.id, phone: athletes.phone, timezone: athletes.timezone })
    .from(athletes)
    .where(isNull(athletes.archivedAt));

  for (const c of candidates) {
    stats.considered++;
    if (!c.timezone) continue;
    const zoned = nowInZone(c.timezone, c.phone, opts.now);
    if (zoned.weekday !== "sunday") continue;
    stats.eligible++;
    const weekStart = computeWeekStart(zoned.date, zoned.weekday);
    try {
      const r = await runWeeklyEvaluationForAthlete({ athleteId: c.id, weekStart });
      if (r.ran) stats.ran++;
    } catch (err) {
      console.error(`weekly evaluation failed for athlete ${c.id}: ${(err as Error).message}`);
    }
  }
  return stats;
}

// ─── Revert ("keep it as it was") ───────────────────────────────────────────

// Deliberately narrow: this triggers a destructive plan overwrite (restore a
// snapshot), so it only matches explicit "undo the change" phrasings — NOT
// loose ones like "don't change my plan" or "keep it the same" that collide
// with ordinary plan-edit conversation (review). The announced phrase is
// "keep it as it was".
const REVERT_Q =
  /\b(keep it (as it was|the way it was|like it was)|revert( that| it| the change| the adjustment)?|undo( that| it| the change| the adjustment)?|put it back( the way it was)?|change it back|don'?t apply that)\b/i;

export function looksLikeRevertRequest(body: string): boolean {
  return REVERT_Q.test(body);
}

// Restore the plan to the snapshot taken before the most recent coach-applied
// weekly adjustment (within 14 days). Returns a confirmation message, or null
// when there's nothing recent to revert (caller falls through to routing).
export async function revertLastWeeklyAdjustment(athleteId: string): Promise<string | null> {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ id: weeklyEvaluations.id, beforePlan: weeklyEvaluations.beforePlan, changeSummary: weeklyEvaluations.changeSummary })
    .from(weeklyEvaluations)
    .where(
      and(
        eq(weeklyEvaluations.athleteId, athleteId),
        eq(weeklyEvaluations.status, "applied"),
        gte(weeklyEvaluations.createdAt, since),
      ),
    )
    .orderBy(desc(weeklyEvaluations.createdAt))
    .limit(1);
  if (!row || !row.beforePlan) return null;

  // Validate the snapshot before restoring — never write an unvalidated blob
  // back as the live plan (review). getStoredPlan checks version + weeks.
  const snapshot = getStoredPlan({ plan: row.beforePlan } as ReturnType<typeof getAthleticHistory>);
  if (!snapshot) return null;

  await saveAthletePlan(athleteId, snapshot);
  await db
    .update(weeklyEvaluations)
    .set({ status: "reverted" })
    .where(eq(weeklyEvaluations.id, row.id));
  const what = row.changeSummary ? ` (${row.changeSummary})` : "";
  return `Done — I've put your plan back the way it was${what}. Tell me any time if you want to revisit it.`;
}
