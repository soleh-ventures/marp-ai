#!/usr/bin/env bun
/**
 * KER-80 (Grounded Coach, Phase 3) — Strava streams history backfill (ops).
 *
 * Walks existing distance-bearing activities with no streams summary and fills
 * them in, per athlete, via backfillAthleteStreams (shared with the connect
 * flow). Throttled + token-refreshing + 429-stopping. Idempotent — re-run to
 * continue. New connects now trigger this automatically in the background;
 * this script is for one-off / historical backfills.
 *
 * Usage:
 *   bun run streams:backfill                 # all connected athletes
 *   bun run streams:backfill <athleteId>     # one athlete
 *   bun run streams:backfill <athleteId> 50  # one athlete, cap 50
 */

import { eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { stravaConnections } from "../db/schema.js";
import { backfillAthleteStreams } from "../services/strava-streams-backfill.js";

async function main(): Promise<void> {
  const athleteArg = process.argv[2];
  const cap = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;

  const conns = await db
    .select({ athleteId: stravaConnections.athleteId })
    .from(stravaConnections)
    .where(
      athleteArg
        ? eq(stravaConnections.athleteId, athleteArg)
        : isNull(stravaConnections.revokedAt),
    );
  console.log(`streams backfill: ${conns.length} athlete(s)\n`);

  let stored = 0;
  let skipped = 0;
  for (const c of conns) {
    const r = await backfillAthleteStreams({ athleteId: c.athleteId, cap });
    stored += r.stored;
    skipped += r.skipped;
    console.log(`athlete ${c.athleteId}: ${r.stored} stored, ${r.skipped} no-streams, ${r.processed} processed${r.stopped ? ` (stopped: ${r.stopped})` : ""}`);
    if (r.stopped === "rate_limited") {
      console.log(`\nRATE LIMITED — stopping. Re-run later to continue.`);
      break;
    }
  }
  console.log(`\nDone: ${stored} stored, ${skipped} no-streams.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("backfill-streams: fatal:", err);
  process.exit(1);
});
