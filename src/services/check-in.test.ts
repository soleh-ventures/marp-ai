import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { activities, athletes } from "../db/schema.js";
import { buildCheckInText, sendPostRunCheckIn } from "./check-in.js";

describe("buildCheckInText (pure)", () => {
  test("references the distance and asks an open question", () => {
    const t = buildCheckInText({ discipline: "run", distanceKm: 12, variant: 0 });
    expect(t).toContain("12k");
    expect(t.toLowerCase()).toContain("how");
    expect(t).toContain("?");
  });

  test("phrasing varies by variant", () => {
    const a = buildCheckInText({ discipline: "run", distanceKm: 10, variant: 0 });
    const b = buildCheckInText({ discipline: "run", distanceKm: 10, variant: 1 });
    expect(a).not.toBe(b);
  });

  test("long runs use the long-run pool", () => {
    const t = buildCheckInText({ discipline: "run", distanceKm: 30, longRun: true, variant: 0 });
    expect(t.toLowerCase()).toMatch(/big one|long run/);
  });

  test("names the runner when known", () => {
    const t = buildCheckInText({ name: "Sam", discipline: "run", distanceKm: 8, variant: 0 });
    expect(t.startsWith("Sam — ")).toBe(true);
  });

  test("no distance on a run → 'that run'", () => {
    const t = buildCheckInText({ discipline: "run", distanceKm: null, variant: 0 });
    expect(t).toContain("that run");
  });

  test("fractional km formats to one decimal", () => {
    const t = buildCheckInText({ discipline: "run", distanceKm: 12.37, variant: 0 });
    expect(t).toContain("12.4k");
  });
});

describe("sendPostRunCheckIn (gated)", () => {
  beforeEach(async () => {
    assertNotProductionDb();
    await db.execute(sql`
      TRUNCATE TABLE
        plan_adjustments, activity_analyses,
        llm_calls, processed_messages, messages, active_flags,
        activities, race_blocks, strava_connections,
        pending_decisions, athletes
      RESTART IDENTITY CASCADE
    `);
  });

  async function seed(discipline: string) {
    const [a] = await db
      .insert(athletes)
      .values({ phone: `+155514${Math.floor(Math.random() * 100000)}`, name: "Runner" })
      .returning();
    if (!a) throw new Error("athlete insert failed");
    const [act] = await db
      .insert(activities)
      .values({
        athleteId: a.id,
        discipline,
        source: "strava",
        sourceId: `c-${Math.random()}`,
        startedAt: new Date("2026-06-08T07:00:00Z"),
        durationS: 1200,
        metrics: { distance_m: 10000 },
      })
      .returning();
    if (!act) throw new Error("activity insert failed");
    return { athleteId: a.id, activityId: act.id };
  }

  test("a run is gated off until proactive outbound is enabled", async () => {
    // PROACTIVE_OUTBOUND is unset in tests → outboundEnabled=false.
    const { athleteId, activityId } = await seed("run");
    const r = await sendPostRunCheckIn({ athleteId, activityId });
    expect(r).toEqual({ sent: false, reason: "proactive_disabled" });
  });

  test("non-run activities never get a check-in", async () => {
    const { athleteId, activityId } = await seed("ride");
    const r = await sendPostRunCheckIn({ athleteId, activityId });
    expect(r).toEqual({ sent: false, reason: "not_a_run" });
  });

  test("missing activity is handled", async () => {
    const r = await sendPostRunCheckIn({
      athleteId: "00000000-0000-0000-0000-000000000000",
      activityId: "00000000-0000-0000-0000-000000000000",
    });
    expect(r).toEqual({ sent: false, reason: "activity_not_found" });
  });
});
