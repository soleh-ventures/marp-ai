import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { athletes, stravaConnections } from "../db/schema.js";
import { backfillStravaHistory } from "./strava-backfill.js";

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`
    TRUNCATE TABLE
      llm_calls, processed_messages, messages, active_flags,
      activities, race_blocks, strava_connections, athletes
    RESTART IDENTITY CASCADE
  `);
});

describe("backfillStravaHistory", () => {
  test("returns no_connection when athlete has never linked Strava", async () => {
    const [a] = await db
      .insert(athletes)
      .values({ phone: "+15551110001", name: "Solo" })
      .returning();
    if (!a) throw new Error("insert failed");
    const result = await backfillStravaHistory(a.id);
    expect(result.reason).toBe("no_connection");
    expect(result.inserted).toBe(0);
    expect(result.fetched).toBe(0);
  });

  test("returns revoked when the connection exists but was revoked", async () => {
    const [a] = await db
      .insert(athletes)
      .values({ phone: "+15551110002", name: "Revoked" })
      .returning();
    if (!a) throw new Error("insert failed");
    await db.insert(stravaConnections).values({
      athleteId: a.id,
      stravaAthleteId: 1234,
      encryptedAccessToken: "x",
      encryptedRefreshToken: "y",
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      scope: "activity:read_all",
      revokedAt: new Date(),
    });
    const result = await backfillStravaHistory(a.id);
    expect(result.reason).toBe("revoked");
    expect(result.inserted).toBe(0);
    expect(result.fetched).toBe(0);
  });
});
