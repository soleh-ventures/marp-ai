import { db } from "../db/client.js";
import { activities } from "../db/schema.js";
import { findByAthleteId } from "./strava-connections.js";
import {
  StravaConnectionRevokedError,
  getFreshAccessToken,
} from "./strava-tokens.js";
import {
  normalizeStravaActivity,
  type StravaActivity,
} from "./strava-activities.js";

// Backfill window in days. 60 was chosen over 30 to clear the standard
// chronic-load windows used in sports science (TrainingPeaks CTL = 42d,
// acute:chronic workload ratio = 28d chronic). Also gives beginners
// enough data points (2 runs/wk × 60d = 16 vs 8 at 30d) for the plan
// generator to detect consistency rather than chance.
const BACKFILL_DAYS_BACK = 60;

// Strava list endpoint caps per_page at 200. Pulling in pages of 200
// keeps the request count to 1 for ~all real-world cases.
const PER_PAGE = 200;

// Safety cap. 1000 activities = ~2 years for an elite, far more than we'd
// ever want in a "recent history" backfill.
const MAX_PAGES = 5;

export type BackfillResult = {
  inserted: number;
  fetched: number;
  reason?: "no_connection" | "revoked";
};

// Pulls the runner's recent Strava history and inserts what isn't
// already in the activities table. Uses the list endpoint (returns
// SummaryActivity), which carries everything our memory context needs
// (distance, pace, HR, sport) in 1-2 API calls.
//
// Safe to run repeatedly — the (source, source_id) unique index plus
// ON CONFLICT DO NOTHING means duplicates from later create webhooks
// are no-ops.
export async function backfillStravaHistory(
  athleteId: string,
  daysBack: number = BACKFILL_DAYS_BACK,
): Promise<BackfillResult> {
  const conn = await findByAthleteId(athleteId);
  if (!conn) return { inserted: 0, fetched: 0, reason: "no_connection" };
  if (conn.revokedAt) return { inserted: 0, fetched: 0, reason: "revoked" };

  let accessToken: string;
  try {
    accessToken = await getFreshAccessToken(conn);
  } catch (err) {
    if (err instanceof StravaConnectionRevokedError) {
      return { inserted: 0, fetched: 0, reason: "revoked" };
    }
    throw err;
  }

  const afterUnix = Math.floor((Date.now() - daysBack * 86400 * 1000) / 1000);
  const summaries = await fetchActivitySummaries(accessToken, afterUnix);

  let inserted = 0;
  for (const a of summaries) {
    const norm = normalizeStravaActivity(a);
    const result = await db
      .insert(activities)
      .values({
        athleteId: conn.athleteId,
        discipline: norm.discipline,
        source: norm.source,
        sourceId: norm.sourceId,
        startedAt: norm.startedAt,
        durationS: norm.durationS,
        metrics: norm.metrics,
        rawPayload: a as Record<string, unknown>,
        longRun: norm.longRun,
      })
      .onConflictDoNothing({
        target: [activities.source, activities.sourceId],
      })
      .returning({ id: activities.id });
    if (result.length > 0) inserted += 1;
  }

  return { inserted, fetched: summaries.length };
}

async function fetchActivitySummaries(
  accessToken: string,
  afterUnix: number,
): Promise<StravaActivity[]> {
  const all: StravaActivity[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url =
      "https://www.strava.com/api/v3/athlete/activities?" +
      new URLSearchParams({
        after: String(afterUnix),
        per_page: String(PER_PAGE),
        page: String(page),
      }).toString();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      throw new Error(
        `Strava GET /athlete/activities ${res.status}: ${body}`,
      );
    }
    const batch = (await res.json()) as StravaActivity[];
    all.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return all;
}
