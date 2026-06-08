// KER-80 (Grounded Coach, Phase 3) — per-athlete streams backfill.
//
// Shared by the ops script (streams:backfill) and the connect flow. New
// activities get streams at ingest (webhook → ingestStravaActivity), but two
// sets don't: activities recorded before Phase 3, and the 60-day history the
// connect flow pulls via the LIST endpoint (which inserts directly, bypassing
// the ingest streams capture). This walks an athlete's activities that have no
// streams summary and fills them in — THROTTLED, because Strava's read budget
// is ~100 req/15min, 1000/day PER APP. Stops on a 429; refreshes the token on
// expiry (a long run can outlive the ~6h TTL); never throws.

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { activities, activityStreams } from "../db/schema.js";
import { findByAthleteId } from "./strava-connections.js";
import { getFreshAccessToken } from "./strava-tokens.js";
import { captureActivityStreams } from "./strava-streams.js";

const DELAY_MS = 800; // ~75 req / 15min — comfortably under the 100 cap
const DEFAULT_CAP = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type StreamsBackfillStats = {
  stored: number;
  skipped: number; // no streams (manual / sparse activity)
  processed: number;
  stopped?: "rate_limited" | "revoked" | "no_connection";
};

async function activitiesNeedingStreams(athleteId: string, cap: number) {
  const rows = await db
    .select({
      id: activities.id,
      sourceId: activities.sourceId,
      discipline: activities.discipline,
      metrics: activities.metrics,
    })
    .from(activities)
    .leftJoin(activityStreams, eq(activityStreams.activityId, activities.id))
    .where(
      and(
        eq(activities.athleteId, athleteId),
        eq(activities.source, "strava"),
        isNotNull(activities.sourceId),
        isNull(activityStreams.id),
      ),
    )
    .orderBy(desc(activities.startedAt))
    .limit(cap);
  return rows.filter((r) => {
    if (r.discipline === "other") return false;
    const m = (r.metrics ?? {}) as Record<string, unknown>;
    return typeof m.distance_m === "number" && m.distance_m > 0;
  });
}

// Backfill streams for ONE athlete. Self-contained: fetches + refreshes the
// token itself. Best-effort and non-throwing — safe to fire-and-forget.
export async function backfillAthleteStreams(input: {
  athleteId: string;
  cap?: number;
}): Promise<StreamsBackfillStats> {
  const cap = input.cap ?? DEFAULT_CAP;
  const stats: StreamsBackfillStats = { stored: 0, skipped: 0, processed: 0 };

  let conn = await findByAthleteId(input.athleteId);
  if (!conn || conn.revokedAt) return { ...stats, stopped: "no_connection" };
  let token: string;
  try {
    token = await getFreshAccessToken(conn);
  } catch {
    return { ...stats, stopped: "revoked" };
  }

  const todo = await activitiesNeedingStreams(input.athleteId, cap);
  for (const a of todo) {
    const sid = Number(a.sourceId);
    if (!Number.isFinite(sid)) continue;
    stats.processed++;
    let outcome = await captureActivityStreams({ accessToken: token, stravaActivityId: sid, activityRowId: a.id });

    if (outcome === "unauthorized") {
      // Token expired mid-run — refresh once and retry, else stop.
      try {
        conn = (await findByAthleteId(input.athleteId)) ?? conn;
        token = await getFreshAccessToken(conn);
        outcome = await captureActivityStreams({ accessToken: token, stravaActivityId: sid, activityRowId: a.id });
      } catch {
        return { ...stats, stopped: "revoked" };
      }
    }

    if (outcome === "stored") stats.stored++;
    else if (outcome === "no_streams") stats.skipped++;
    else if (outcome === "rate_limited") return { ...stats, stopped: "rate_limited" };
    await sleep(DELAY_MS);
  }
  return stats;
}
