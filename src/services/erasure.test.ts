import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import {
  activeFlags,
  activities,
  athletes,
  llmCalls,
  messages,
  raceBlocks,
  stravaConnections,
} from "../db/schema.js";
import { deleteAthlete } from "./erasure.js";

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`
    TRUNCATE TABLE
      llm_calls, processed_messages, messages, active_flags,
      activities, race_blocks, strava_connections, athletes
    RESTART IDENTITY CASCADE
  `);
});

describe("deleteAthlete", () => {
  test("removes the athlete row and cascades to every linked table", async () => {
    // Seed a fully-populated athlete so every cascade path is exercised.
    const [a] = await db
      .insert(athletes)
      .values({ phone: "+15551110001", name: "Erase Me" })
      .returning();
    if (!a) throw new Error("insert failed");

    const [block] = await db
      .insert(raceBlocks)
      .values({
        athleteId: a.id,
        raceName: "Test Marathon",
        raceDate: new Date("2026-12-01"),
        raceDistance: "marathon",
        state: "active",
      })
      .returning();
    if (!block) throw new Error("race_block insert failed");

    await db.insert(activities).values({
      athleteId: a.id,
      raceBlockId: block.id,
      discipline: "run",
      source: "strava",
      sourceId: "erase-1",
      startedAt: new Date("2026-05-01T06:00:00Z"),
      durationS: 3600,
      metrics: { distance_m: 10000 },
      longRun: false,
    });
    await db.insert(activeFlags).values({
      athleteId: a.id,
      kind: "injury",
      body: "left achilles tight",
    });
    const [msg] = await db
      .insert(messages)
      .values({
        athleteId: a.id,
        direction: "in",
        body: "delete me",
        twilioMessageSid: "SM-erase-1",
      })
      .returning();
    if (!msg) throw new Error("message insert failed");
    await db.insert(stravaConnections).values({
      athleteId: a.id,
      stravaAthleteId: 99999,
      encryptedAccessToken: "x",
      encryptedRefreshToken: "y",
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      scope: "activity:read_all",
    });
    await db.insert(llmCalls).values({
      athleteId: a.id,
      messageId: msg.id,
      component: "classifier",
      model: "claude-haiku-4-5",
      tokensIn: 100,
      tokensOut: 50,
      costEstimateUsd: 0.0001,
      latencyMs: 250,
    });

    const result = await deleteAthlete(a.id);
    expect(result.deleted).toBe(true);

    // Athlete-linked rows should be gone via CASCADE.
    expect(
      await db.select().from(athletes).where(eq(athletes.id, a.id)),
    ).toEqual([]);
    expect(
      await db.select().from(raceBlocks).where(eq(raceBlocks.athleteId, a.id)),
    ).toEqual([]);
    expect(
      await db.select().from(activities).where(eq(activities.athleteId, a.id)),
    ).toEqual([]);
    expect(
      await db.select().from(activeFlags).where(eq(activeFlags.athleteId, a.id)),
    ).toEqual([]);
    expect(
      await db.select().from(messages).where(eq(messages.athleteId, a.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(stravaConnections)
        .where(eq(stravaConnections.athleteId, a.id)),
    ).toEqual([]);

    // llm_calls row survives with athlete_id NULLed — preserves aggregate
    // cost telemetry without retaining PII linkage.
    const remainingCalls = await db.select().from(llmCalls);
    expect(remainingCalls).toHaveLength(1);
    expect(remainingCalls[0]?.athleteId).toBeNull();
    expect(remainingCalls[0]?.messageId).toBeNull();
    expect(remainingCalls[0]?.tokensIn).toBe(100);
  });

  test("returns deleted=false for a non-existent athlete (idempotent)", async () => {
    const result = await deleteAthlete("00000000-0000-0000-0000-000000000000");
    expect(result.deleted).toBe(false);
  });
});
