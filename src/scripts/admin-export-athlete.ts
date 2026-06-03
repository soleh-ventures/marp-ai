#!/usr/bin/env bun
/**
 * Admin: export everything we hold on a single athlete (GDPR Article 15).
 *
 * Usage:
 *   bun run admin:export-athlete <athlete-uuid> [--out path.json]
 *
 * Prints the export to stdout as JSON by default; pass --out to write
 * to a file instead (useful for large exports). Strava encrypted
 * tokens are redacted — the runner is requesting a copy of *their*
 * data, not the symmetric key material that protects it. Other Strava
 * connection metadata (timestamps, scope, athlete id) is included
 * because that's data about them.
 *
 * For local / dev:
 *   bun run src/scripts/admin-export-athlete.ts <uuid>
 *
 * For prod (Railway):
 *   railway run -- bun run src/scripts/admin-export-athlete.ts <uuid>
 */

import { writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  activeFlags,
  activities,
  athletes,
  messages,
  pendingDecisions,
  raceBlocks,
  stravaConnections,
} from "../db/schema.js";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

async function buildExport(athleteId: string): Promise<unknown> {
  const [athlete] = await db
    .select()
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  if (!athlete) {
    throw new Error(`No athlete found with id ${athleteId}.`);
  }

  // Pull everything else in parallel — none of the queries are large
  // and they're independent.
  const [msgs, acts, flags, blocks, conns, decisions] = await Promise.all([
    db.select().from(messages).where(eq(messages.athleteId, athleteId)),
    db.select().from(activities).where(eq(activities.athleteId, athleteId)),
    db.select().from(activeFlags).where(eq(activeFlags.athleteId, athleteId)),
    db.select().from(raceBlocks).where(eq(raceBlocks.athleteId, athleteId)),
    db
      .select()
      .from(stravaConnections)
      .where(eq(stravaConnections.athleteId, athleteId)),
    db
      .select()
      .from(pendingDecisions)
      .where(eq(pendingDecisions.athleteId, athleteId)),
  ]);

  // Redact the encrypted Strava tokens. The runner is asking for their
  // data, not the symmetric key material. We surface enough metadata
  // that the runner can see "yes my Strava is connected, here's when,
  // here's the scope" without exposing the raw token blob.
  const stravaConnectionsRedacted = conns.map((c) => ({
    id: c.id,
    stravaAthleteId: c.stravaAthleteId,
    scope: c.scope,
    connectedAt: c.connectedAt,
    lastRefreshedAt: c.lastRefreshedAt,
    revokedAt: c.revokedAt,
    tokenExpiresAt: c.tokenExpiresAt,
    encryptedAccessToken: "<redacted>",
    encryptedRefreshToken: "<redacted>",
  }));

  return {
    exportedAt: new Date().toISOString(),
    gdprArticle: "Article 15 — right of access",
    athlete: {
      id: athlete.id,
      phone: athlete.phone,
      name: athlete.name,
      locale: athlete.locale,
      athleticHistory: athlete.athleticHistory,
      lastSeenAt: athlete.lastSeenAt,
      archivedAt: athlete.archivedAt,
      consentGrantedAt: athlete.consentGrantedAt,
      createdAt: athlete.createdAt,
    },
    messages: msgs.map((m) => ({
      direction: m.direction,
      body: m.body,
      mediaUrl: m.mediaUrl,
      receivedAt: m.receivedAt,
      resolvesPendingDecisionId: m.resolvesPendingDecisionId,
    })),
    activities: acts,
    activeFlags: flags,
    raceBlocks: blocks,
    pendingDecisions: decisions,
    stravaConnections: stravaConnectionsRedacted,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const uuid = args.find((a) => !a.startsWith("--"));
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;

  if (!uuid || !isUuid(uuid)) {
    console.error(
      "Usage: bun run admin:export-athlete <athlete-uuid> [--out path.json]",
    );
    process.exit(1);
  }

  const data = await buildExport(uuid);
  const json = JSON.stringify(data, null, 2);

  if (outPath) {
    await writeFile(outPath, json, "utf-8");
    console.error(`Wrote export to ${outPath}.`);
  } else {
    process.stdout.write(json + "\n");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("admin-export-athlete failed:", err);
  process.exit(1);
});
