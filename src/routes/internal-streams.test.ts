import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { app } from "../server.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { activities, activityStreams, athletes } from "../db/schema.js";

// Deep workout analysis (option B): the Garmin sidecar POSTs normalized
// per-sample channels here; the route runs the ONE pure summarizeStreams and
// stores the compact result. These tests cover auth, activity resolution, and
// that the deep channels (laps + HR zones) survive the round-trip.

const SECRET = "test-cron-secret";

async function seedGarminRun(sourceId: string) {
  const [a] = await db
    .insert(athletes)
    .values({ phone: `+155514${Math.floor(Math.random() * 100000)}`, name: "Runner" })
    .returning();
  if (!a) throw new Error("athlete insert failed");
  const [act] = await db
    .insert(activities)
    .values({
      athleteId: a.id,
      discipline: "run",
      source: "garmin",
      sourceId,
      startedAt: new Date("2026-07-01T06:00:00Z"),
      durationS: 540,
      metrics: { distance_m: 2000, avg_pace_s_per_km: 270, avg_hr: 154 },
    })
    .returning();
  if (!act) throw new Error("activity insert failed");
  return { athleteId: a.id, activityId: act.id };
}

// A 2km run: km1 300s, km2 240s (negative split), with cadence + laps + zones.
function payload(sourceId: string) {
  return {
    source: "garmin",
    source_id: sourceId,
    streams: {
      time: { data: [0, 60, 120, 180, 240, 300, 360, 420, 480, 540] },
      distance: { data: [0, 150, 350, 550, 750, 1000, 1300, 1600, 1850, 2000] },
      heartrate: { data: [140, 145, 150, 150, 152, 155, 158, 160, 162, 165] },
      cadence: { data: [170, 172, 171, 173, 170, 172, 171, 170, 172, 171] },
    },
    laps: [
      { index: 1, distance_m: 1000, time_s: 300, avg_hr: 148, avg_pace_s_per_km: 300 },
      { index: 2, distance_m: 1000, time_s: 240, avg_hr: 160, avg_pace_s_per_km: 240 },
    ],
    hr_zone_seconds: [
      { zone: 2, seconds: 300 },
      { zone: 3, seconds: 240 },
    ],
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return app.request("/internal/streams/summarize", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

let savedSecret: string | undefined;

beforeEach(async () => {
  assertNotProductionDb();
  savedSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  await db.execute(sql`
    TRUNCATE TABLE
      activity_streams, activity_analyses, activities, athletes
    RESTART IDENTITY CASCADE
  `);
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
});

describe("POST /internal/streams/summarize", () => {
  test("summarizes + stores the deep summary for a matching activity", async () => {
    const { activityId } = await seedGarminRun("g-100");
    const res = await post(payload("g-100"), { "X-Cron-Secret": SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: true });

    const [row] = await db
      .select({ summary: activityStreams.summary })
      .from(activityStreams)
      .where(eq(activityStreams.activityId, activityId));
    expect(row).toBeDefined();
    const s = row!.summary as {
      split_pattern: string;
      laps?: unknown[];
      hr_zones?: unknown[];
      cadence?: { avg: number };
    };
    expect(s.split_pattern).toBe("negative");
    expect(s.laps).toHaveLength(2);
    expect(s.hr_zones).toHaveLength(2);
    expect(s.cadence?.avg).toBe(171);
  });

  test("re-POST upserts (no duplicate row, refreshes summary)", async () => {
    const { activityId } = await seedGarminRun("g-200");
    await post(payload("g-200"), { "X-Cron-Secret": SECRET });
    const res2 = await post(payload("g-200"), { "X-Cron-Secret": SECRET });
    expect(res2.status).toBe(200);
    const rows = await db
      .select({ id: activityStreams.id })
      .from(activityStreams)
      .where(eq(activityStreams.activityId, activityId));
    expect(rows).toHaveLength(1);
  });

  test("rejects a wrong / missing secret", async () => {
    await seedGarminRun("g-300");
    expect((await post(payload("g-300"), { "X-Cron-Secret": "nope" })).status).toBe(403);
    expect((await post(payload("g-300"))).status).toBe(403);
  });

  test("503 when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    expect((await post(payload("g-300"), { "X-Cron-Secret": SECRET })).status).toBe(503);
  });

  test("404 when no activity matches (source, source_id)", async () => {
    await seedGarminRun("g-400");
    const res = await post(payload("g-unknown"), { "X-Cron-Secret": SECRET });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "activity_not_found" });
  });

  test("400 on a malformed body", async () => {
    const res = await post({ source: "garmin" }, { "X-Cron-Secret": SECRET });
    expect(res.status).toBe(400);
  });

  test("stored:false when the streams can't yield a summary", async () => {
    await seedGarminRun("g-500");
    const res = await post(
      { source: "garmin", source_id: "g-500", streams: { time: { data: [0] } } },
      { "X-Cron-Secret": SECRET },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, stored: false });
    const rows = await db.select({ id: activityStreams.id }).from(activityStreams);
    expect(rows).toHaveLength(0);
  });
});
