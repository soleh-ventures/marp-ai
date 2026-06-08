// M1 (T2) — post-run analysis.
//
// When a new run lands, MARP reads it: the OBJECTIVE half of the feedback
// loop. Two steps, separated on purpose so the cheap reliable part never
// depends on the expensive flaky part:
//
//   1. computeObjectiveRead() — pure, in-code stats from data we ALREADY have
//      (the normalized metrics + the Strava splits in raw_payload). No extra
//      Strava API calls; streams-based HR-zone distribution is deferred to M2.
//   2. an LLM call that interprets those stats into a one-line coach's read.
//      If it fails, the objective stats are still stored (coach_read stays
//      null) — non-fatal.
//
// Result is upserted onto activity_analyses keyed by activity_id, so it
// coexists with whatever the feeling-extraction path (T4) writes.
//
// runPostRunPipeline() is the orchestrator the Strava webhook fires on a new
// run: check-in (T3, decoupled) + analysis, each independently fault-isolated.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { activities, activityAnalyses, athletes } from "../db/schema.js";
import { config } from "../config.js";
import { getAthleticHistory } from "../flows/onboarding.js";
import { getPostRunAnalysisPrompt } from "../router/prompts.js";
import { llmCall } from "./llm-call.js";
import { getStoredPlan } from "./plan/storage.js";
import { sessionDate, type Plan } from "./plan/types.js";
import { sendPostRunCheckIn } from "./check-in.js";
import { loadStreamSummaries, renderStreamAnnotation } from "./strava-streams.js";

export type PerKm = { km: number; pace_s_per_km: number; hr: number | null };

export type ObjectiveRead = {
  // Whether the per-km read came from real splits or we fell back to the
  // activity summary (splits absent / too short).
  source: "splits" | "summary";
  distance_km: number | null;
  duration_s: number | null;
  avg_pace_s_per_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  per_km: PerKm[] | null;
  // (2nd-half pace − 1st-half pace) / 1st-half, %. Positive = slowed down.
  pace_drift_pct: number | null;
  split_pattern: "negative" | "even" | "positive" | null;
  // 2nd-half vs 1st-half average HR, %. Positive = cardiac drift.
  hr_drift_pct: number | null;
};

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// Pure: derive the objective read from the normalized metrics + the raw
// Strava payload. Defensive against missing/short/garbled splits.
export function computeObjectiveRead(
  rawPayload: unknown,
  metrics: unknown,
): ObjectiveRead {
  const m = (metrics ?? {}) as Record<string, unknown>;
  const raw = (rawPayload ?? {}) as Record<string, unknown>;
  const distM = asNum(m.distance_m);
  const base: ObjectiveRead = {
    source: "summary",
    distance_km: distM != null ? round1(distM / 1000) : null,
    duration_s: asNum(raw.moving_time),
    avg_pace_s_per_km: asNum(m.avg_pace_s_per_km),
    avg_hr: asNum(m.avg_hr),
    max_hr: asNum(m.max_hr),
    per_km: null,
    pace_drift_pct: null,
    split_pattern: null,
    hr_drift_pct: null,
  };

  const splits = Array.isArray(raw.splits_metric) ? raw.splits_metric : null;
  if (!splits || splits.length < 2) return base;

  const perKm: PerKm[] = [];
  for (let i = 0; i < splits.length; i++) {
    const s = (splits[i] ?? {}) as Record<string, unknown>;
    const dist = asNum(s.distance);
    const moving = asNum(s.moving_time);
    const avgSpeed = asNum(s.average_speed);
    let pace: number | null = null;
    if (moving != null && dist != null && dist > 0) {
      pace = Math.round(moving / (dist / 1000));
    } else if (avgSpeed != null && avgSpeed > 0) {
      pace = Math.round(1000 / avgSpeed);
    }
    if (pace == null) continue;
    perKm.push({ km: asNum(s.split) ?? i + 1, pace_s_per_km: pace, hr: asNum(s.average_heartrate) });
  }
  if (perKm.length < 2) return base;

  const mid = Math.floor(perKm.length / 2);
  const firstPace = avg(perKm.slice(0, mid).map((p) => p.pace_s_per_km));
  const secondPace = avg(perKm.slice(mid).map((p) => p.pace_s_per_km));
  const paceDrift =
    firstPace > 0 ? round1(((secondPace - firstPace) / firstPace) * 100) : null;
  const split_pattern =
    paceDrift == null ? null : paceDrift < -1.5 ? "negative" : paceDrift > 1.5 ? "positive" : "even";

  const firstHr = perKm.slice(0, mid).map((p) => p.hr).filter((h): h is number => h != null);
  const secondHr = perKm.slice(mid).map((p) => p.hr).filter((h): h is number => h != null);
  let hrDrift: number | null = null;
  if (firstHr.length && secondHr.length) {
    const f = avg(firstHr);
    if (f > 0) hrDrift = round1(((avg(secondHr) - f) / f) * 100);
  }

  return {
    ...base,
    source: "splits",
    per_km: perKm,
    pace_drift_pct: paceDrift,
    split_pattern,
    hr_drift_pct: hrDrift,
  };
}

// Best-effort: which planned session lines up with this activity's date?
// Gives the LLM "effort vs intent" context. UTC calendar match — good enough
// for a context line (runs are logged on their own day); never blocks.
export function findPlannedSession(
  plan: Plan,
  startedAt: Date,
): { type: string; description: string } | null {
  const dateStr = startedAt.toISOString().slice(0, 10);
  for (const week of plan.weeks) {
    for (const s of week.sessions) {
      if (sessionDate(plan.start_date, week.index, s.day_of_week) === dateStr) {
        return { type: s.type, description: s.description };
      }
    }
  }
  return null;
}

export type AnalyzeResult =
  | { ok: true; coachRead: string | null }
  | { ok: false; reason: "not_found" | "not_a_run" };

// Computes + stores the objective read, then asks the LLM for the coach's
// read. The LLM step is fault-isolated: a failure logs and leaves coach_read
// null but still persists the objective stats.
export async function analyzeActivity(input: {
  athleteId: string;
  activityId: string;
}): Promise<AnalyzeResult> {
  const [act] = await db
    .select({
      discipline: activities.discipline,
      metrics: activities.metrics,
      rawPayload: activities.rawPayload,
      startedAt: activities.startedAt,
      longRun: activities.longRun,
    })
    .from(activities)
    .where(eq(activities.id, input.activityId))
    .limit(1);
  if (!act) return { ok: false, reason: "not_found" };
  if (act.discipline !== "run") return { ok: false, reason: "not_a_run" };

  const objective = computeObjectiveRead(act.rawPayload, act.metrics);

  // KER-80 (Phase 3): the streams summary adds split pattern + HR drift the
  // raw_payload splits don't carry. Captured at ingest, so it's available by
  // the time the post-run pipeline runs.
  const streamMap = await loadStreamSummaries([input.activityId]);
  const streamSummary = streamMap.get(input.activityId) ?? null;
  const streamLine = streamSummary
    ? `# Stream detail (per-km splits, split pattern, HR drift)\n${renderStreamAnnotation(streamSummary)}\n\n`
    : "";

  // Planned-session context (best effort).
  let plannedLine = "Planned session today: (unknown / unscheduled)";
  const [ath] = await db
    .select({ athleticHistory: athletes.athleticHistory })
    .from(athletes)
    .where(eq(athletes.id, input.athleteId))
    .limit(1);
  const plan = ath ? getStoredPlan(getAthleticHistory(ath.athleticHistory)) : null;
  if (plan) {
    const planned = findPlannedSession(plan, act.startedAt);
    if (planned) plannedLine = `Planned session today: ${planned.type} — ${planned.description}`;
  }

  let coachRead: string | null = null;
  try {
    const user =
      `# Objective stats (pre-computed — do not recompute)\n${JSON.stringify(objective)}\n\n` +
      streamLine +
      `# Discipline\nrun${act.longRun ? " (long run)" : ""}\n\n` +
      `# ${plannedLine}\n\n` +
      `# Task\nWrite the coach's read of this run (1-2 sentences, plain text, no question).`;
    const res = await llmCall(
      {
        model: config.llm.domainModel,
        system: getPostRunAnalysisPrompt(),
        user,
        maxTokens: 300,
        temperature: 0.4,
        cacheSystem: true,
      },
      { athleteId: input.athleteId, component: "content" },
    );
    const trimmed = res.text.trim();
    coachRead = trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    console.error(
      `run-analysis: LLM read failed for activity ${input.activityId} (objective still stored): ${(err as Error).message}`,
    );
  }

  // Upsert keyed by activity_id — coexists with a feeling row (T4) if it
  // already landed; we only set the objective half here.
  await db
    .insert(activityAnalyses)
    .values({
      athleteId: input.athleteId,
      activityId: input.activityId,
      objective,
      coachRead,
    })
    .onConflictDoUpdate({
      target: activityAnalyses.activityId,
      set: { objective, coachRead, updatedAt: new Date() },
    });

  return { ok: true, coachRead };
}

// Orchestrator fired by the Strava webhook on a newly-inserted activity.
// Check-in and analysis are independent (decision 4A) and each fault-isolated
// so one failing never blocks the other.
export async function runPostRunPipeline(input: {
  athleteId: string;
  activityId: string;
}): Promise<void> {
  try {
    const r = await sendPostRunCheckIn(input);
    if (!r.sent && r.reason && r.reason !== "not_a_run") {
      console.log(`post-run check-in skipped (${r.reason}) for activity ${input.activityId}`);
    }
  } catch (err) {
    console.error(`post-run check-in failed for ${input.activityId}: ${(err as Error).message}`);
  }
  try {
    await analyzeActivity(input);
  } catch (err) {
    console.error(`post-run analysis failed for ${input.activityId}: ${(err as Error).message}`);
  }
}
