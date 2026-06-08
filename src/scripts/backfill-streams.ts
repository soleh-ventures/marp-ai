#!/usr/bin/env bun
/**
 * KER-80 (Grounded Coach, Phase 3) — Strava streams history backfill.
 *
 * New activities get their streams summarized at ingest, but history doesn't.
 * This walks existing distance-bearing activities that have no activity_streams
 * row yet and fetches + summarizes them — THROTTLED, because Strava's read
 * budget is ~100 req/15min, 1000/day PER APP (one token pool across all
 * athletes). So we: sleep between calls, cap per run, and STOP the whole run
 * the moment Strava 429s (captureActivityStreams returns "rate_limited").
 * Re-run it later to pick up where it left off (idempotent — already-summarized
 * activities are skipped).
 *
 * Usage:
 *   bun run streams:backfill                 # all athletes, default cap
 *   bun run streams:backfill <athleteId>     # one athlete
 *   bun run streams:backfill <athleteId> 50  # one athlete, cap 50
 */

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { activities, activityStreams, stravaConnections } from "../db/schema.js";
import { findByAthleteId } from "../services/strava-connections.js";
import { getFreshAccessToken, StravaConnectionRevokedError } from "../services/strava-tokens.js";
import { captureActivityStreams } from "../services/strava-streams.js";

const DELAY_MS = 800; // ~75 req / 15min — comfortably under the 100 cap
const DEFAULT_CAP = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  // Distance-bearing, non-"other" only (the streams summary needs distance).
  return rows.filter((r) => {
    if (r.discipline === "other") return false;
    const m = (r.metrics ?? {}) as Record<string, unknown>;
    return typeof m.distance_m === "number" && m.distance_m > 0;
  });
}

async function main(): Promise<void> {
  const athleteArg = process.argv[2];
  const cap = process.argv[3] ? parseInt(process.argv[3], 10) : DEFAULT_CAP;

  const conns = await db
    .select()
    .from(stravaConnections)
    .where(
      athleteArg
        ? and(eq(stravaConnections.athleteId, athleteArg), isNull(stravaConnections.revokedAt))
        : isNull(stravaConnections.revokedAt),
    );
  console.log(`streams backfill: ${conns.length} connection(s), cap ${cap}/run\n`);

  let stored = 0;
  let skipped = 0;
  let processed = 0;

  for (const conn of conns) {
    if (processed >= cap) break;
    let token: string;
    try {
      token = await getFreshAccessToken(conn);
    } catch (err) {
      if (err instanceof StravaConnectionRevokedError) {
        console.log(`athlete ${conn.athleteId}: revoked, skipping`);
        continue;
      }
      throw err;
    }

    const todo = await activitiesNeedingStreams(conn.athleteId, cap - processed);
    console.log(`athlete ${conn.athleteId}: ${todo.length} activities need streams`);

    let abandonAthlete = false;
    for (const a of todo) {
      if (processed >= cap || abandonAthlete) break;
      // Strava ids are numeric; guard against a non-numeric sourceId so we
      // don't fire GET /activities/NaN/streams.
      const sid = Number(a.sourceId);
      if (!Number.isFinite(sid)) continue;
      processed++;
      let outcome = await captureActivityStreams({ accessToken: token, stravaActivityId: sid, activityRowId: a.id });

      // The access token can expire mid-run (Strava TTL ~6h). On 401, refresh
      // once and retry — otherwise a long backfill silently no-ops the rest.
      if (outcome === "unauthorized") {
        try {
          const fresh = await findByAthleteId(conn.athleteId);
          if (!fresh) { abandonAthlete = true; continue; }
          token = await getFreshAccessToken(fresh);
          outcome = await captureActivityStreams({ accessToken: token, stravaActivityId: sid, activityRowId: a.id });
        } catch {
          console.log(`athlete ${conn.athleteId}: token refresh failed, skipping rest`);
          abandonAthlete = true;
          continue;
        }
      }

      if (outcome === "stored") stored++;
      else if (outcome === "no_streams") skipped++;
      else if (outcome === "rate_limited") {
        console.log(`\nRATE LIMITED — stopping. Re-run later to continue.`);
        console.log(`Summary: ${stored} stored, ${skipped} no-streams, ${processed} processed.`);
        process.exit(0);
      }
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nDone: ${stored} stored, ${skipped} no-streams, ${processed} processed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("backfill-streams: fatal:", err);
  process.exit(1);
});
