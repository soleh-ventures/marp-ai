// M1 (T5) — proactive weekly retro / pattern detector.
//
// The coaching brain's "weekend retro": look at how the week actually went and
// decide whether next week's plan should change. Two trigger paths (decision
// 3A): a weekly sweep on the in-process tick, and an event-driven path on a
// strong post-run signal. Either way MARP PROPOSES via a decision_frame →
// pending_decisions (decision 2A — never silently auto-applies); the
// confirm→apply path (T6) resolves it. Idempotent through plan_adjustments.
//
// Cost discipline: a stable week makes no LLM call. We gather signals in code
// first and only ask the model when they warrant review (and, for the weekly
// sweep, only once per week via the plan_adjustments idempotency key).
//
// OUTBOUND (sending the proposal) is gated behind config.proactive.outboundEnabled
// like the check-in — the proposal + pending_decision are still recorded so the
// loop is built + testable; the actual send flips on at launch.

import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import {
  activeFlags,
  activityAnalyses,
  athletes,
  pendingDecisions,
  planAdjustments,
} from "../db/schema.js";
import { getAthleticHistory } from "../flows/onboarding.js";
import { getRetroProposalPrompt } from "../router/prompts.js";
import { llmCall } from "./llm-call.js";
import { adjustPlan } from "./plan/adjust.js";
import { getStoredPlan, saveAthletePlan } from "./plan/storage.js";
import { renderPlanForContext } from "./plan/types.js";
import { nowInZone } from "./reminders/timezone.js";
import { sendWhatsApp } from "./twilio-send.js";
import { deliver } from "./messaging/deliver.js";

const WEEK_WINDOW_DAYS = 7;
const DOW_ORDER = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export type WeekSignals = {
  runs: number;
  hard_efforts: number; // rpe >= 8 or band hard/max
  avg_rpe: number | null;
  low_energy: number; // energy low/depleted
  cut_or_skipped: number; // adherence cut_short/skipped
  positive_splits: number;
  rising_hr_drift: number; // hr_drift_pct > 5
  pain: boolean; // feeling pain OR an open injury flag
};

type WeekRow = { objective: unknown; feeling: unknown; coachRead: string | null };

// Monday (YYYY-MM-DD) of the week containing the given local date.
export function computeWeekStart(localDate: string, weekday: string): string {
  const idx = Math.max(0, DOW_ORDER.indexOf(weekday));
  const base = new Date(`${localDate}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return localDate;
  base.setUTCDate(base.getUTCDate() - idx);
  return base.toISOString().slice(0, 10);
}

// Pure: roll the week's analysis rows (+ whether an injury flag is open) into
// the signal summary the warrant-gate and the LLM both read.
export function computeWeekSignals(rows: WeekRow[], hasInjuryFlag: boolean): WeekSignals {
  let hard = 0;
  let lowEnergy = 0;
  let cutSkipped = 0;
  let positiveSplits = 0;
  let risingDrift = 0;
  let painFromFeeling = false;
  const rpes: number[] = [];

  for (const r of rows) {
    const f = (r.feeling ?? {}) as Record<string, unknown>;
    const effort = (f.effort ?? {}) as Record<string, unknown>;
    const rpe = typeof effort.rpe === "number" ? effort.rpe : null;
    const band = typeof effort.band === "string" ? effort.band : null;
    if (rpe != null) rpes.push(rpe);
    if ((rpe != null && rpe >= 8) || band === "hard" || band === "max") hard++;
    if (f.energy === "low" || f.energy === "depleted") lowEnergy++;
    if (f.adherence === "cut_short" || f.adherence === "skipped") cutSkipped++;
    const pain = (f.pain ?? {}) as Record<string, unknown>;
    if (pain.present === true) painFromFeeling = true;

    const o = (r.objective ?? {}) as Record<string, unknown>;
    if (o.split_pattern === "positive") positiveSplits++;
    if (typeof o.hr_drift_pct === "number" && o.hr_drift_pct > 5) risingDrift++;
  }

  return {
    runs: rows.length,
    hard_efforts: hard,
    avg_rpe: rpes.length ? Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10 : null,
    low_energy: lowEnergy,
    cut_or_skipped: cutSkipped,
    positive_splits: positiveSplits,
    rising_hr_drift: risingDrift,
    pain: painFromFeeling || hasInjuryFlag,
  };
}

// Pure: do the signals warrant asking the model at all? Conservative — a
// stable week returns false and costs no LLM call.
export function weekSignalsWarrant(s: WeekSignals): boolean {
  return (
    s.pain ||
    s.hard_efforts >= 2 ||
    s.cut_or_skipped >= 2 ||
    s.low_energy >= 2 ||
    s.rising_hr_drift >= 2
  );
}

export type RetroProposal = {
  summary: string;
  rationale: string;
  edit_request: string;
  decision_frame: {
    question: string;
    options: Array<{ key: string; label: string; action_hint?: string }>;
  };
};

// Pure, defensive parse. Returns null when the model declined to adjust or the
// payload is malformed (mirrors the other extractors — never throws).
export function parseProposal(raw: string): RetroProposal | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.adjust !== true) return null;

  const summary = strOrNull(o.summary);
  const rationale = strOrNull(o.rationale);
  const editRequest = strOrNull(o.edit_request);
  if (!summary || !rationale || !editRequest) return null;

  const frame = (o.decision_frame ?? {}) as Record<string, unknown>;
  const question = strOrNull(frame.question);
  if (!question) return null;
  if (!Array.isArray(frame.options)) return null;
  const options: RetroProposal["decision_frame"]["options"] = [];
  const seen = new Set<string>();
  for (const raw of frame.options) {
    if (!raw || typeof raw !== "object") continue;
    const opt = raw as Record<string, unknown>;
    const key = strOrNull(opt.key);
    const label = strOrNull(opt.label);
    if (!key || !label || seen.has(key)) continue;
    seen.add(key);
    const ah = strOrNull(opt.action_hint);
    options.push(ah ? { key, label, action_hint: ah } : { key, label });
  }
  if (options.length < 2) return null;

  return { summary, rationale, edit_request: editRequest, decision_frame: { question, options } };
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export async function loadWeekRows(athleteId: string): Promise<WeekRow[]> {
  const since = new Date(Date.now() - WEEK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return db
    .select({
      objective: activityAnalyses.objective,
      feeling: activityAnalyses.feeling,
      coachRead: activityAnalyses.coachRead,
    })
    .from(activityAnalyses)
    .where(and(eq(activityAnalyses.athleteId, athleteId), gte(activityAnalyses.createdAt, since)))
    .orderBy(desc(activityAnalyses.createdAt));
}

export async function openFlags(athleteId: string): Promise<Array<{ kind: string; body: string }>> {
  return db
    .select({ kind: activeFlags.kind, body: activeFlags.body })
    .from(activeFlags)
    .where(and(eq(activeFlags.athleteId, athleteId), isNull(activeFlags.resolvedAt)));
}

export function summarizeFeeling(feeling: unknown): string {
  const f = (feeling ?? null) as Record<string, unknown> | null;
  if (!f) return "(no feeling)";
  const effort = (f.effort ?? {}) as Record<string, unknown>;
  const pain = (f.pain ?? {}) as Record<string, unknown>;
  const bits = [
    effort.rpe != null ? `rpe ${effort.rpe}` : effort.band ? `${effort.band}` : null,
    f.energy && f.energy !== "unknown" ? `${f.energy}` : null,
    f.adherence && f.adherence !== "unknown" ? `${f.adherence}` : null,
    pain.present === true ? "PAIN" : null,
  ].filter(Boolean);
  return bits.length ? bits.join(", ") : "(no feeling)";
}

export type RetroResult =
  | { proposed: true; adjustmentId: string; pendingDecisionId: string; sent: boolean }
  | {
      proposed: false;
      reason:
        | "already_proposed"
        | "recent_proposal"
        | "no_plan"
        | "stable_week"
        | "llm_no_change";
    };

export type RetroTrigger = "weekly_sweep" | "event";

export async function runWeeklyRetro(input: {
  athleteId: string;
  weekStart: string;
  trigger: RetroTrigger;
}): Promise<RetroResult> {
  const { athleteId, weekStart, trigger } = input;

  // Idempotency / anti-spam guards.
  if (trigger === "weekly_sweep") {
    const [existing] = await db
      .select({ id: planAdjustments.id })
      .from(planAdjustments)
      .where(
        and(
          eq(planAdjustments.athleteId, athleteId),
          eq(planAdjustments.weekStart, weekStart),
          eq(planAdjustments.trigger, "weekly_sweep"),
        ),
      )
      .limit(1);
    if (existing) return { proposed: false, reason: "already_proposed" };
  } else {
    // Event path: don't pile proposals — skip if one is still open from the
    // last 24h.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [recent] = await db
      .select({ id: planAdjustments.id })
      .from(planAdjustments)
      .where(
        and(
          eq(planAdjustments.athleteId, athleteId),
          eq(planAdjustments.status, "proposed"),
          gte(planAdjustments.createdAt, since),
        ),
      )
      .limit(1);
    if (recent) return { proposed: false, reason: "recent_proposal" };
  }

  const [ath] = await db
    .select({
      phone: athletes.phone,
      athleticHistory: athletes.athleticHistory,
    })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  const plan = ath ? getStoredPlan(getAthleticHistory(ath.athleticHistory)) : null;
  if (!plan) return { proposed: false, reason: "no_plan" };

  const rows = await loadWeekRows(athleteId);
  const flags = await openFlags(athleteId);
  const hasInjury = flags.some((f) => f.kind === "injury");
  const signals = computeWeekSignals(rows, hasInjury);

  // Stable week on the scheduled sweep → no LLM. (Event triggers already
  // fired on a strong signal, so we always consult the model for them.)
  if (trigger === "weekly_sweep" && !weekSignalsWarrant(signals)) {
    return { proposed: false, reason: "stable_week" };
  }

  const reads =
    rows
      .map((r) => `- ${r.coachRead ?? "(no read)"} | feeling: ${summarizeFeeling(r.feeling)}`)
      .join("\n") || "(no runs this week)";
  const flagLine = flags.length ? flags.map((f) => `${f.kind}: ${f.body}`).join("; ") : "none";
  const user =
    `# Current plan\n${renderPlanForContext(plan)}\n\n` +
    `# This week's signals\n${JSON.stringify(signals)}\n\n` +
    `# Per-run reads this week\n${reads}\n\n` +
    `# Open flags\n${flagLine}\n\n` +
    `# Trigger\n${trigger} (week of ${weekStart})\n\n` +
    `# Task\nDecide whether to adjust the plan. Return ONLY the JSON described in your instructions.`;

  const res = await llmCall(
    {
      model: config.llm.domainModel,
      system: getRetroProposalPrompt(),
      user,
      maxTokens: 700,
      temperature: 0.3,
      cacheSystem: true,
    },
    { athleteId, component: "domain" },
  );

  const proposal = parseProposal(res.text);
  if (!proposal) return { proposed: false, reason: "llm_no_change" };

  // Record the proposal: a pending_decision (for the binder to resolve in T6)
  // + the plan_adjustments log row (idempotency + audit), linked together.
  const [pd] = await db
    .insert(pendingDecisions)
    .values({ athleteId, frame: proposal.decision_frame })
    .returning({ id: pendingDecisions.id });
  if (!pd) throw new Error("pending_decision insert returned nothing");

  const [adj] = await db
    .insert(planAdjustments)
    .values({
      athleteId,
      trigger,
      weekStart,
      proposal,
      status: "proposed",
      pendingDecisionId: pd.id,
    })
    .returning({ id: planAdjustments.id });
  if (!adj) throw new Error("plan_adjustment insert returned nothing");

  // Gated outbound — build the loop now, actually send at launch. The
  // outbound message row + linking the pending_decision to it lands with the
  // template send path (KER-75); here we just deliver the proposal text.
  let sent = false;
  if (config.proactive.outboundEnabled && ath) {
    const text = `${proposal.summary}\n\n${proposal.rationale}\n\n${proposal.decision_frame.question}`;
    await deliver(input.athleteId, text);
    sent = true;
  }

  return { proposed: true, adjustmentId: adj.id, pendingDecisionId: pd.id, sent };
}

export type SweepStats = { considered: number; eligible: number; proposed: number };

// Weekly sweep, fired from the in-process tick. Fires the retro for athletes
// whose local day is Sunday (the end-of-week retro), idempotent per week so it
// runs at most once regardless of how many ticks land on their Sunday.
export async function runWeeklyRetroSweep(opts: { now: Date }): Promise<SweepStats> {
  const stats: SweepStats = { considered: 0, eligible: 0, proposed: 0 };
  const candidates = await db
    .select({
      id: athletes.id,
      phone: athletes.phone,
      timezone: athletes.timezone,
    })
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
      const r = await runWeeklyRetro({ athleteId: c.id, weekStart, trigger: "weekly_sweep" });
      if (r.proposed) stats.proposed++;
    } catch (err) {
      console.error(`weekly retro failed for athlete ${c.id}: ${(err as Error).message}`);
    }
  }
  return stats;
}

// Event-driven retro: fired (fire-and-forget) when a strong post-run signal is
// captured (pain / very hard effort). Guards inside runWeeklyRetro keep it from
// piling proposals.
export async function maybeEventRetro(input: { athleteId: string }): Promise<void> {
  const [ath] = await db
    .select({ phone: athletes.phone, timezone: athletes.timezone })
    .from(athletes)
    .where(eq(athletes.id, input.athleteId))
    .limit(1);
  if (!ath) return;
  const zoned = nowInZone(ath.timezone, ath.phone);
  const weekStart = computeWeekStart(zoned.date, zoned.weekday);
  try {
    await runWeeklyRetro({ athleteId: input.athleteId, weekStart, trigger: "event" });
  } catch (err) {
    console.error(`event retro failed for athlete ${input.athleteId}: ${(err as Error).message}`);
  }
}

// M1 (T6) — confirm → apply.
//
// Called after the binder resolves a frame. If that frame belongs to a retro
// proposal (plan_adjustments.pending_decision_id), apply or decline it:
//   - key === "accept" → feed the stored edit_request to the existing
//     adjustPlan, save, mark the adjustment applied.
//   - any other key (e.g. "keep") → mark declined, plan untouched.
// A no-op for frames that aren't retro proposals (ordinary conversational
// forks). adjustPlan failure leaves the adjustment 'proposed' so it can retry.
export type ApplyResult = {
  applied: boolean;
  status?: "applied" | "declined";
  reason?: "not_a_proposal" | "already_resolved" | "adjust_failed";
};

export async function applyProposalResolution(input: {
  athleteId: string;
  messageId: string;
  frameId: string;
  key: string;
}): Promise<ApplyResult> {
  const [adj] = await db
    .select({
      id: planAdjustments.id,
      status: planAdjustments.status,
      proposal: planAdjustments.proposal,
    })
    .from(planAdjustments)
    .where(eq(planAdjustments.pendingDecisionId, input.frameId))
    .limit(1);
  if (!adj) return { applied: false, reason: "not_a_proposal" };
  if (adj.status !== "proposed") return { applied: false, reason: "already_resolved" };

  // The retro-proposal convention is that the affirmative option's key is
  // "accept" (enforced by the prompt). Anything else is a decline.
  if (input.key !== "accept") {
    await db
      .update(planAdjustments)
      .set({ status: "declined" })
      .where(eq(planAdjustments.id, adj.id));
    return { applied: false, status: "declined" };
  }

  const editRequest = (adj.proposal as RetroProposal).edit_request;
  const res = await adjustPlan({
    athleteId: input.athleteId,
    messageId: input.messageId,
    editRequest,
  });
  if (!res.ok) {
    console.error(
      `proposal apply: adjustPlan failed (${res.reason}) for adjustment ${adj.id} — left proposed`,
    );
    return { applied: false, reason: "adjust_failed" };
  }
  await saveAthletePlan(input.athleteId, res.plan);
  await db
    .update(planAdjustments)
    .set({ status: "applied", appliedAt: new Date() })
    .where(eq(planAdjustments.id, adj.id));
  return { applied: true, status: "applied" };
}
