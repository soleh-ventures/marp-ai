#!/usr/bin/env bun
/**
 * Admin: delete an athlete and all their data (GDPR Article 17).
 *
 * Usage:
 *   bun run admin:delete-athlete <athlete-uuid>
 *
 * The script prints a summary of what's about to be deleted, then waits
 * for an interactive confirmation. Pass `--yes` to skip the prompt
 * (useful for scripted batch deletes; require human review otherwise).
 *
 * For local / dev:
 *   bun run src/scripts/admin-delete-athlete.ts <uuid>
 *
 * For prod (Railway):
 *   railway run -- bun run src/scripts/admin-delete-athlete.ts <uuid>
 */

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  activeFlags,
  activities,
  athletes,
  messages,
  raceBlocks,
  stravaConnections,
} from "../db/schema.js";
import { deleteAthlete } from "../services/erasure.js";
import { redactPhone } from "../services/phone-redact.js";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

async function promptYesNo(question: string): Promise<boolean> {
  process.stdout.write(`${question} `);
  for await (const line of console as unknown as AsyncIterable<string>) {
    return line.trim().toUpperCase() === "YES";
  }
  return false;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipConfirm = args.includes("--yes");
  const uuid = args.find((a) => a !== "--yes");

  if (!uuid || !isUuid(uuid)) {
    console.error("Usage: bun run admin:delete-athlete <athlete-uuid> [--yes]");
    process.exit(1);
  }

  // Read the row first so we can show the operator what's about to go.
  // Phone is redacted in output — GDPR best practice is to never have
  // the full number land in terminal scrollback.
  const [athlete] = await db
    .select()
    .from(athletes)
    .where(eq(athletes.id, uuid))
    .limit(1);
  if (!athlete) {
    console.error(`No athlete found with id ${uuid}.`);
    process.exit(1);
  }

  const [
    messageCount,
    activityCount,
    raceBlockCount,
    activeFlagCount,
    stravaConnCount,
  ] = await Promise.all([
    countRows(messages, eq(messages.athleteId, uuid)),
    countRows(activities, eq(activities.athleteId, uuid)),
    countRows(raceBlocks, eq(raceBlocks.athleteId, uuid)),
    countRows(activeFlags, eq(activeFlags.athleteId, uuid)),
    countRows(stravaConnections, eq(stravaConnections.athleteId, uuid)),
  ]);

  console.log("About to delete:");
  console.log(`  athlete id:       ${athlete.id}`);
  console.log(`  phone:            ${redactPhone(athlete.phone)}`);
  console.log(`  name:             ${athlete.name ?? "(unknown)"}`);
  console.log(`  created:          ${athlete.createdAt.toISOString()}`);
  console.log(`  messages:         ${messageCount}`);
  console.log(`  activities:       ${activityCount}`);
  console.log(`  race blocks:      ${raceBlockCount}`);
  console.log(`  active flags:     ${activeFlagCount}`);
  console.log(`  strava conns:     ${stravaConnCount}`);
  console.log("");

  if (!skipConfirm) {
    const ok = await promptYesNo("Type YES to permanently delete:");
    if (!ok) {
      console.log("Cancelled. No data deleted.");
      process.exit(0);
    }
  }

  const result = await deleteAthlete(uuid);
  if (!result.deleted) {
    console.error("Delete returned deleted=false — was the athlete already gone?");
    process.exit(1);
  }
  console.log(`Done. Athlete ${uuid} and all related data deleted.`);
  process.exit(0);
}

// Minimal count helper — drizzle's count() returns a slightly awkward
// shape and we just want a number per table for the summary.
async function countRows<T>(
  table: T,
  where: ReturnType<typeof eq>,
): Promise<number> {
  // biome-ignore lint: drizzle types here are dynamic enough that the
  // signature would be more noise than help in a one-off script.
  const rows = await db.select().from(table as never).where(where);
  return rows.length;
}

main().catch((err) => {
  console.error("admin-delete-athlete failed:", err);
  process.exit(1);
});
