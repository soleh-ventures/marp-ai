// M1 (T4) — RunFeeling extraction.
//
// The SUBJECTIVE half of the feedback loop. When a runner replies (to a
// post-run check-in, or just volunteers how a run went), we turn their
// free text into a structured RunFeeling and store it on activity_analyses
// alongside the objective read. Same extraction pattern as the flag-detector
// (cheap Haiku call), grounded in the run's objective read so the model can
// reconcile "felt easy" against the data without overwriting perceived effort.
//
// Cost guard: we only call the LLM when the athlete has a RUN in the last
// RECENT_RUN_WINDOW_H hours — i.e. there's actually a run for the feeling to
// attach to. Outside that window this is a single cheap SELECT and a no-op,
// so wiring it into the per-inbound batch is affordable.
//
// Pain handling (DRY): pain is RECORDED in the RunFeeling for the retro to
// reason over, but we do NOT create injury active_flags here — the existing
// flag-detector already owns that path and runs on the same inbound. Writing
// to two different tables (active_flags vs activity_analyses.feeling) means no
// duplicate flags.

import { and, desc, eq, gte } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { activities, activityAnalyses } from "../db/schema.js";
import { getFeelingExtractPrompt } from "../router/prompts.js";
import { llmCall } from "./llm-call.js";
import { maybeEventRetro } from "./run-retro.js";

const RECENT_RUN_WINDOW_H = 48;

export type EffortBand = "easy" | "moderate" | "hard" | "max" | "unknown";
export type Energy = "positive" | "neutral" | "low" | "depleted" | "unknown";
export type Adherence =
  | "as_planned"
  | "cut_short"
  | "extended"
  | "modified"
  | "skipped"
  | "unknown";

export type RunFeeling = {
  effort: { rpe: number | null; band: EffortBand };
  energy: Energy;
  pain: { present: boolean; location: string | null; severity: number | null };
  adherence: Adherence;
  context: string | null;
  // The runner's own words — always kept verbatim.
  verbatim: string;
};

export type FeelingResult =
  | { captured: true; activityId: string; feeling: RunFeeling }
  | { captured: false; reason: "empty" | "no_recent_run" | "no_feeling_signal" };

const BANDS: ReadonlySet<string> = new Set(["easy", "moderate", "hard", "max", "unknown"]);
const ENERGIES: ReadonlySet<string> = new Set([
  "positive",
  "neutral",
  "low",
  "depleted",
  "unknown",
]);
const ADHERENCES: ReadonlySet<string> = new Set([
  "as_planned",
  "cut_short",
  "extended",
  "modified",
  "skipped",
  "unknown",
]);

export async function extractRunFeeling(input: {
  athleteId: string;
  messageId: string;
  body: string;
}): Promise<FeelingResult> {
  if (!input.body.trim()) return { captured: false, reason: "empty" };

  // Cost guard: only a recent run gives the feeling something to attach to.
  const since = new Date(Date.now() - RECENT_RUN_WINDOW_H * 60 * 60 * 1000);
  const [act] = await db
    .select({ id: activities.id })
    .from(activities)
    .where(
      and(
        eq(activities.athleteId, input.athleteId),
        eq(activities.discipline, "run"),
        gte(activities.startedAt, since),
      ),
    )
    .orderBy(desc(activities.startedAt))
    .limit(1);
  if (!act) return { captured: false, reason: "no_recent_run" };

  // Ground against the objective read of that run, when we have it.
  const [an] = await db
    .select({ objective: activityAnalyses.objective })
    .from(activityAnalyses)
    .where(eq(activityAnalyses.activityId, act.id))
    .limit(1);

  const user =
    `# Most recent run (objective read)\n${an?.objective ? JSON.stringify(an.objective) : "(no analysis yet)"}\n\n` +
    `# Runner's message\n${input.body}`;

  const res = await llmCall(
    {
      model: config.llm.binderModel, // Haiku — same cheap tier as the flag-detector
      system: getFeelingExtractPrompt(),
      user,
      maxTokens: 300,
      temperature: 0,
      cacheSystem: true,
    },
    { athleteId: input.athleteId, messageId: input.messageId, component: "memory" },
  );

  const feeling = parseFeeling(res.text, input.body);
  if (!feeling) return { captured: false, reason: "no_feeling_signal" };

  await db
    .insert(activityAnalyses)
    .values({ athleteId: input.athleteId, activityId: act.id, feeling })
    .onConflictDoUpdate({
      target: activityAnalyses.activityId,
      set: { feeling, updatedAt: new Date() },
    });

  // M1 (T5): a strong post-run signal triggers an event-driven retro (decision
  // 3A) — fire-and-forget; runWeeklyRetro's guards prevent proposal spam.
  const strong =
    feeling.pain.present ||
    (feeling.effort.rpe != null && feeling.effort.rpe >= 8) ||
    feeling.effort.band === "max";
  if (strong) {
    void maybeEventRetro({ athleteId: input.athleteId }).catch((err) => {
      console.error(`event retro trigger failed: ${(err as Error).message}`);
    });
  }

  return { captured: true, activityId: act.id, feeling };
}

// Defensive parse — mirrors the flag-detector. Returns null when the model
// says there's no feeling signal (or the payload is unusable); coerces unknown
// enum values to their safe defaults rather than throwing.
export function parseFeeling(raw: string, verbatim: string): RunFeeling | null {
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
  const f = (obj as Record<string, unknown>).feeling;
  if (f === null || f === undefined) return null;
  if (typeof f !== "object") return null;
  const o = f as Record<string, unknown>;

  const effortObj = (o.effort ?? {}) as Record<string, unknown>;
  const rpeRaw = effortObj.rpe;
  const rpe =
    typeof rpeRaw === "number" && rpeRaw >= 1 && rpeRaw <= 10 ? Math.round(rpeRaw) : null;
  const band = typeof effortObj.band === "string" && BANDS.has(effortObj.band)
    ? (effortObj.band as EffortBand)
    : "unknown";

  const energy =
    typeof o.energy === "string" && ENERGIES.has(o.energy) ? (o.energy as Energy) : "unknown";

  const painObj = (o.pain ?? {}) as Record<string, unknown>;
  const sevRaw = painObj.severity;
  const pain = {
    present: painObj.present === true,
    location: typeof painObj.location === "string" ? painObj.location : null,
    severity:
      typeof sevRaw === "number" && sevRaw >= 1 && sevRaw <= 10 ? Math.round(sevRaw) : null,
  };

  const adherence =
    typeof o.adherence === "string" && ADHERENCES.has(o.adherence)
      ? (o.adherence as Adherence)
      : "unknown";

  const context =
    typeof o.context === "string" && o.context.trim().length > 0 ? o.context.trim() : null;

  return { effort: { rpe, band }, energy, pain, adherence, context, verbatim };
}
