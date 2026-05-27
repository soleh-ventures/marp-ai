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
): Promise<{ inserted: boolean; reason?: string }> {
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

  const inserted = await db
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

  return { inserted: inserted.length > 0 };
}

// Exposed for direct testing of the connection lookup path without
// hitting the network.
export const _internal = { fetchStravaActivity };

export type { StravaConnection };
