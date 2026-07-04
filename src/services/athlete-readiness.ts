// Athlete recovery + training-load analytics for the coaching brain.
//
// Two derived signals the coach reads before advising:
//  1. Readiness — the Garmin FR245 recovery proxy (percentile-of-3), written by
//     the garmin-sidecar into garmin_wellness. Here we just read the latest
//     scored day + a 3-day trend.
//  2. Training load — acute:chronic workload ratio (ACWR) + Foster monotony,
//     computed from the existing `activities` table (source-agnostic: Strava or
//     Garmin). Load proxy = session minutes; ACWR = last-7d load vs the 28-day
//     weekly average. 0.8-1.3 is the "optimal" band; >1.5 is a spike (injury risk).
//
// Everything here is best-effort context: getRecoveryContext returns null rather
// than throwing so a missing sidecar / empty table never breaks a coach reply.

import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { activities, garminWellness } from "../db/schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type TrainingLoad = {
  acuteMinutes: number; // last 7 days
  chronicWeeklyMinutes: number; // last 28 days / 4
  acwr: number | null; // acute : chronic-weekly
  monotony: number | null; // Foster: mean daily / SD daily over 7d
  strain: number | null; // acute load * monotony
  flag: "detraining" | "optimal" | "ramping" | "spike" | null;
};

// Pure, testable. daily7[6] is today; total28Min is the 28-day sum in minutes.
export function computeTrainingLoad(
  daily7: number[],
  total28Min: number,
): TrainingLoad {
  const acute = daily7.reduce((a, b) => a + b, 0);
  const chronicWeekly = total28Min / 4;
  const acwr = chronicWeekly > 0 ? acute / chronicWeekly : null;
  const mean = acute / 7;
  const variance = daily7.reduce((s, x) => s + (x - mean) ** 2, 0) / 7;
  const sd = Math.sqrt(variance);
  // Monotony is undefined when every day is identical (SD 0); report null
  // rather than Infinity so downstream formatting stays sane.
  const monotony = sd > 0 ? mean / sd : null;
  const strain = monotony !== null ? acute * monotony : null;
  const flag =
    acwr === null
      ? null
      : acwr < 0.8
        ? "detraining"
        : acwr <= 1.3
          ? "optimal"
          : acwr <= 1.5
            ? "ramping"
            : "spike";
  const r1 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
  return {
    acuteMinutes: Math.round(acute),
    chronicWeeklyMinutes: Math.round(chronicWeekly),
    acwr: r1(acwr),
    monotony: r1(monotony),
    strain: strain === null ? null : Math.round(strain),
    flag,
  };
}

export async function getTrainingLoad(
  athleteId: string,
  now: Date = new Date(),
): Promise<TrainingLoad | null> {
  const since28 = new Date(now.getTime() - 28 * DAY_MS);
  const rows = await db
    .select({ startedAt: activities.startedAt, durationS: activities.durationS })
    .from(activities)
    .where(
      and(
        eq(activities.athleteId, athleteId),
        gte(activities.startedAt, since28),
      ),
    );
  if (rows.length === 0) return null;

  const daily7 = new Array(7).fill(0);
  let total28Min = 0;
  for (const r of rows) {
    const minutes = (r.durationS ?? 0) / 60;
    total28Min += minutes;
    const ageDays = Math.floor((now.getTime() - r.startedAt.getTime()) / DAY_MS);
    if (ageDays >= 0 && ageDays < 7) daily7[6 - ageDays] += minutes;
  }
  return computeTrainingLoad(daily7, total28Min);
}

export type Readiness = {
  score: number;
  band: string; // green | amber | red
  date: string;
  trend: "up" | "down" | "flat" | null;
};

export async function getReadiness(athleteId: string): Promise<Readiness | null> {
  const rows = await db
    .select({
      date: garminWellness.date,
      score: garminWellness.readinessScore,
      band: garminWellness.readinessBand,
    })
    .from(garminWellness)
    .where(
      and(
        eq(garminWellness.athleteId, athleteId),
        isNotNull(garminWellness.readinessScore),
      ),
    )
    .orderBy(desc(garminWellness.date))
    .limit(3);
  const latest = rows[0];
  if (!latest || latest.score === null) return null;

  const prior = rows
    .slice(1)
    .map((r) => r.score)
    .filter((n): n is number => n !== null);
  let trend: Readiness["trend"] = null;
  if (prior.length > 0) {
    const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;
    const delta = latest.score - priorAvg;
    trend = delta > 4 ? "up" : delta < -4 ? "down" : "flat";
  }
  return { score: latest.score, band: latest.band ?? "unknown", date: latest.date, trend };
}

const BAND_WORDS: Record<string, string> = {
  green: "well recovered",
  amber: "moderately recovered",
  red: "under-recovered",
};

// Single line injected into the coaching context. null when there's nothing to
// say (no wearable data and no activities), so we never inject an empty header.
export async function getRecoveryContext(
  athleteId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const [readiness, load] = await Promise.all([
    getReadiness(athleteId).catch(() => null),
    getTrainingLoad(athleteId, now).catch(() => null),
  ]);
  if (!readiness && !load) return null;

  const bits: string[] = [];
  if (readiness) {
    const words = BAND_WORDS[readiness.band] ?? readiness.band;
    const trend = readiness.trend ? `, 3-day trend ${readiness.trend}` : "";
    bits.push(
      `readiness ${words} (${readiness.score}/100, ${readiness.date}${trend})`,
    );
  }
  if (load && load.acwr !== null) {
    const mono = load.monotony !== null ? `, monotony ${load.monotony}` : "";
    bits.push(
      `training load: 7d ${load.acuteMinutes}min vs weekly-avg ${load.chronicWeeklyMinutes}min → ACWR ${load.acwr} (${load.flag})${mono}`,
    );
  }
  if (bits.length === 0) return null;
  return `Recovery & load (Garmin): ${bits.join("; ")}.`;
}
