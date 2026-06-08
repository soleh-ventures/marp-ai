import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../db/client.js";
import { activities } from "../db/schema.js";
import {
  type StravaConnection,
  findByStravaAthleteId,
} from "./strava-connections.js";
import {
  StravaConnectionRevokedError,
  getFreshAccessToken,
} from "./strava-tokens.js";
import {
  extractIanaFromStravaTz,
  inferTimezoneFromPhone,
} from "./reminders/timezone.js";
import { captureActivityStreams } from "./strava-streams.js";

// Heuristic threshold for tagging an activity as a "long run". Doesn't
// account for the runner's individual training base — that's done at a
// higher layer. 16 km matches the common base-period long-run floor.
const LONG_RUN_MIN_DISTANCE_M = 16_000;

// Map Strava sport_type → MARP's discipline vocabulary. We collapse
// running variants (Run, TrailRun, VirtualRun) into "run"; cycling and
// swimming are their own buckets; anything else falls through to "other".
const SPORT_TYPE_MAP: Record<string, string> = {
  Run: "run",
  TrailRun: "run",
  VirtualRun: "run",
  Ride: "ride",
  VirtualRide: "ride",
  GravelRide: "ride",
  MountainBikeRide: "ride",
  Swim: "swim",
  Walk: "walk",
  Hike: "hike",
  WeightTraining: "strength",
  Workout: "strength",
  Yoga: "mobility",
  Elliptical: "cross",
  StairStepper: "cross",
};

export function mapSportType(sportType: string | undefined): string {
  if (!sportType) return "other";
  return SPORT_TYPE_MAP[sportType] ?? "other";
}

// Strava activity response — only the fields we use. The full payload is
// stored in raw_payload, so we don't need to model everything.
export type StravaActivity = {
  id: number;
  name?: string;
  sport_type?: string;
  type?: string;
  start_date: string; // ISO 8601, UTC
  moving_time: number; // seconds
  elapsed_time?: number;
  distance: number; // meters
  total_elevation_gain?: number;
  average_speed?: number; // m/s
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  calories?: number;
  has_heartrate?: boolean;
  // The detailed activity GET includes the runner's free-text description /
  // notes ("legs felt heavy, eased off the last 2k"). Rich coaching signal.
  description?: string;
};

export type NormalizedActivity = {
  discipline: string;
  source: "strava";
  sourceId: string;
  startedAt: Date;
  durationS: number;
  metrics: Record<string, number | string | null>;
  longRun: boolean;
};

export function normalizeStravaActivity(a: StravaActivity): NormalizedActivity {
  const discipline = mapSportType(a.sport_type ?? a.type);
  const startedAt = new Date(a.start_date);
  // Prefer moving_time over elapsed_time for training metrics — elapsed
  // includes red lights, water stops, etc.
  const durationS = a.moving_time;

  // Avg pace only makes sense for distance-bearing activities. Skip for
  // strength / yoga / etc.
  const distanceM = a.distance ?? 0;
  const avgPaceSPerKm =
    distanceM > 0 && durationS > 0
      ? Math.round(durationS / (distanceM / 1000))
      : null;

  const metrics: Record<string, number | string | null> = {
    distance_m: distanceM,
    elev_gain_m: a.total_elevation_gain ?? null,
    avg_pace_s_per_km: avgPaceSPerKm,
    avg_hr: a.average_heartrate ?? null,
    max_hr: a.max_heartrate ?? null,
    avg_cadence: a.average_cadence ?? null,
    calories: a.calories ?? null,
    name: a.name ?? null,
    // KER-80: the runner's own notes on the activity, when they wrote any.
    description: a.description && a.description.trim() ? a.description.trim() : null,
  };

  return {
    discipline,
    source: "strava",
    sourceId: String(a.id),
    startedAt,
    durationS,
    metrics,
    longRun: discipline === "run" && distanceM >= LONG_RUN_MIN_DISTANCE_M,
  };
}

async function fetchStravaActivity(
  accessToken: string,
  activityId: number,
): Promise<StravaActivity> {
  const res = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Strava GET /activities/${activityId} ${res.status}: ${text}`);
  }
  return (await res.json()) as StravaActivity;
}

// Top-level entry from the webhook. Looks up the connection, ensures a
// fresh access token, fetches the activity, normalizes, and upserts.
// Returns true if a new row was inserted; false if the row already
// existed (idempotent redelivery) or the athlete isn't connected.
export async function ingestStravaActivity(
  stravaAthleteId: number,
  activityId: number,
): Promise<{
  inserted: boolean;
  reason?: string;
  // M1 (T2/T3): on a NEW insert, the ids the webhook needs to fire the
  // post-run pipeline (analysis + check-in). Absent on no-op redeliveries.
  athleteId?: string;
  activityId?: string;
}> {
  const conn = await findByStravaAthleteId(stravaAthleteId);
  if (!conn) {
    return { inserted: false, reason: "no_connection" };
  }
  if (conn.revokedAt) {
    return { inserted: false, reason: "revoked" };
  }

  let accessToken: string;
  try {
    accessToken = await getFreshAccessToken(conn);
  } catch (err) {
    if (err instanceof StravaConnectionRevokedError) {
      return { inserted: false, reason: "revoked" };
    }
    throw err;
  }

  const raw = await fetchStravaActivity(accessToken, activityId);
  const norm = normalizeStravaActivity(raw);

  const insertedRows = await db
    .insert(activities)
    .values({
      athleteId: conn.athleteId,
      discipline: norm.discipline,
      source: norm.source,
      sourceId: norm.sourceId,
      startedAt: norm.startedAt,
      durationS: norm.durationS,
      metrics: norm.metrics,
      rawPayload: raw as Record<string, unknown>,
      longRun: norm.longRun,
    })
    .onConflictDoNothing({
      target: [activities.source, activities.sourceId],
    })
    .returning({ id: activities.id });

  const newId = insertedRows[0]?.id;
  if (!newId) return { inserted: false };

  // KER-80 (Phase 3): capture the streams summary (per-km splits, HR drift,
  // split pattern) for any DISTANCE-bearing activity — runs, rides, swims,
  // walks, hikes — not just runs (bug #5: "include my other activities too").
  // The summarizer is sport-agnostic. Strength/mobility have no distance, so
  // they're skipped by the distance check. Best-effort — captureActivity
  // Streams never throws, so a rate limit / sparse data / network blip can't
  // affect ingest or the post-run pipeline. A future backfill handles history.
  if ((raw.distance ?? 0) > 0 && norm.discipline !== "other") {
    const outcome = await captureActivityStreams({
      accessToken,
      stravaActivityId: activityId,
      activityRowId: newId,
    });
    if (outcome !== "stored" && outcome !== "no_streams") {
      console.log(`strava streams capture: ${outcome} for activity ${newId}`);
    }
  }

  return { inserted: true, athleteId: conn.athleteId, activityId: newId };
}

// F8c (v1.2): the IANA timezone of the runner's most recent activity,
// read from the stored raw Strava payload. Reflects where they actually
// trained — accurate for expats/travellers in a way the phone dial code
// never is. Returns null when no activity has a usable timezone.
export async function latestActivityTimezone(
  athleteId: string,
): Promise<string | null> {
  const rows = await db
    .select({ rawPayload: activities.rawPayload })
    .from(activities)
    .where(
      and(eq(activities.athleteId, athleteId), eq(activities.source, "strava")),
    )
    .orderBy(desc(activities.startedAt))
    .limit(1);
  const raw = rows[0]?.rawPayload as Record<string, unknown> | undefined;
  if (!raw) return null;
  return extractIanaFromStravaTz(raw.timezone);
}

// F8c (v1.2): the best timezone to PERSIST for an athlete, in priority
// order: Strava-derived (where they run) → phone dial code → null. The
// caller stores the result; resolveTimezone() then reads it as the
// authoritative stored value. Async because the Strava lookup hits the
// DB; phone inference is the cheap fallback when Strava isn't connected.
export async function bestTimezoneForAthlete(
  athleteId: string,
  phone: string,
): Promise<string | null> {
  const fromStrava = await latestActivityTimezone(athleteId).catch(() => null);
  if (fromStrava) return fromStrava;
  return inferTimezoneFromPhone(phone);
}

// F3 (v1.2): a one-line fitness summary from the runner's recent runs,
// so onboarding can SKIP asking for weekly mileage / longest run when we
// already have the data. Looks at the last 28 days of run activities.
// Returns null when there's nothing to summarise (not connected, or no
// runs yet) — caller then asks the fitness questions as normal.
export async function summarizeRecentTraining(
  athleteId: string,
): Promise<{ weeklyKm: number; longestKm: number } | null> {
  const since = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ metrics: activities.metrics })
    .from(activities)
    .where(
      and(
        eq(activities.athleteId, athleteId),
        eq(activities.discipline, "run"),
        gte(activities.startedAt, since),
      ),
    );
  if (rows.length === 0) return null;
  let totalM = 0;
  let longestM = 0;
  for (const r of rows) {
    const m = (r.metrics as Record<string, unknown> | null) ?? {};
    const dist = typeof m.distance_m === "number" ? m.distance_m : 0;
    totalM += dist;
    if (dist > longestM) longestM = dist;
  }
  if (totalM === 0) return null;
  return {
    weeklyKm: Math.round(totalM / 1000 / 4),
    longestKm: Math.round(longestM / 1000),
  };
}

// Exposed for direct testing of the connection lookup path without
// hitting the network.
export const _internal = { fetchStravaActivity };

export type { StravaConnection };
