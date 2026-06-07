import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { activities, activityAnalyses, athletes } from "../db/schema.js";
import { _resetProviderCache, mockProvider } from "./llm/index.js";
import {
  analyzeActivity,
  computeObjectiveRead,
  findPlannedSession,
} from "./run-analysis.js";
import { saveAthletePlan } from "./plan/storage.js";
import { parsePlan } from "./plan/types.js";

beforeAll(() => {
  (config.llm as { provider: "mock" | "anthropic" }).provider = "mock";
  _resetProviderCache();
});

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
  mockProvider.reset();
});

function splits(paces: number[], hrs?: number[]) {
  return paces.map((p, i) => ({
    split: i + 1,
    distance: 1000,
    moving_time: p,
    average_speed: 1000 / p,
    average_heartrate: hrs ? hrs[i] : undefined,
  }));
}

describe("computeObjectiveRead (pure)", () => {
  test("even pace + rising HR → source splits, even pattern, positive HR drift", () => {
    const o = computeObjectiveRead(
      { moving_time: 1200, splits_metric: splits([300, 300, 300, 300], [150, 152, 158, 160]) },
      { distance_m: 4000, avg_pace_s_per_km: 300, avg_hr: 155, max_hr: 160 },
    );
    expect(o.source).toBe("splits");
    expect(o.per_km).toHaveLength(4);
    expect(o.split_pattern).toBe("even");
    expect(o.pace_drift_pct).toBe(0);
    expect(o.hr_drift_pct).not.toBeNull();
    expect(o.hr_drift_pct!).toBeGreaterThan(0);
    expect(o.distance_km).toBe(4);
  });

  test("slowing second half → positive split", () => {
    const o = computeObjectiveRead(
      { splits_metric: splits([290, 295, 310, 320]) },
      { distance_m: 4000 },
    );
    expect(o.split_pattern).toBe("positive");
    expect(o.pace_drift_pct!).toBeGreaterThan(1.5);
    // No per-km HR → HR drift not computed.
    expect(o.hr_drift_pct).toBeNull();
  });

  test("faster second half → negative split", () => {
    const o = computeObjectiveRead({ splits_metric: splits([320, 310, 295, 290]) }, {});
    expect(o.split_pattern).toBe("negative");
    expect(o.pace_drift_pct!).toBeLessThan(-1.5);
  });

  test("no splits → graceful summary fallback", () => {
    const o = computeObjectiveRead(
      { something_else: true },
      { distance_m: 8000, avg_pace_s_per_km: 330, avg_hr: 148 },
    );
    expect(o.source).toBe("summary");
    expect(o.per_km).toBeNull();
    expect(o.pace_drift_pct).toBeNull();
    expect(o.split_pattern).toBeNull();
    expect(o.distance_km).toBe(8);
    expect(o.avg_pace_s_per_km).toBe(330);
  });
});

describe("findPlannedSession (pure)", () => {
  const plan = parsePlan({
    source: "generated",
    start_date: "2026-06-08", // Monday
    weeks: [
      {
        index: 1,
        sessions: [
          { day_of_week: "monday", type: "easy", description: "Easy 8K Z2" },
          { day_of_week: "sunday", type: "long", description: "Long 20K" },
        ],
      },
    ],
  });

  test("matches the session on the activity's date", () => {
    const s = findPlannedSession(plan, new Date("2026-06-08T07:00:00Z"));
    expect(s?.type).toBe("easy");
    expect(s?.description).toContain("Easy 8K");
  });

  test("returns null when no session lands on that date", () => {
    expect(findPlannedSession(plan, new Date("2026-06-10T07:00:00Z"))).toBeNull();
  });
});

async function seedRun(opts: { discipline?: string; sourceId: string; raw?: unknown }) {
  const [a] = await db
    .insert(athletes)
    .values({ phone: `+155513${Math.floor(Math.random() * 100000)}`, name: "Runner" })
    .returning();
  if (!a) throw new Error("athlete insert failed");
  const [act] = await db
    .insert(activities)
    .values({
      athleteId: a.id,
      discipline: opts.discipline ?? "run",
      source: "strava",
      sourceId: opts.sourceId,
      startedAt: new Date("2026-06-08T07:00:00Z"),
      durationS: 1200,
      metrics: { distance_m: 4000, avg_pace_s_per_km: 300, avg_hr: 155, max_hr: 162 },
      rawPayload: (opts.raw ?? { splits_metric: splits([300, 300, 305, 300], [150, 153, 158, 161]) }) as Record<string, unknown>,
    })
    .returning();
  if (!act) throw new Error("activity insert failed");
  return { athleteId: a.id, activityId: act.id };
}

describe("analyzeActivity (DB + mock LLM)", () => {
  test("stores objective + coachRead for a run", async () => {
    const { athleteId, activityId } = await seedRun({ sourceId: "a1" });
    mockProvider.setResponses([
      { match: "coach's read", text: "Even splits, HR steady in Z2 — clean easy run." },
    ]);
    const res = await analyzeActivity({ athleteId, activityId });
    expect(res.ok).toBe(true);
    const [row] = await db
      .select()
      .from(activityAnalyses)
      .where(eq(activityAnalyses.activityId, activityId));
    expect((row?.objective as { source?: string })?.source).toBe("splits");
    expect(row?.coachRead).toContain("Z2");
    expect(row?.feeling).toBeNull();
  });

  test("skips non-run activities", async () => {
    const { athleteId, activityId } = await seedRun({ discipline: "ride", sourceId: "a2" });
    const res = await analyzeActivity({ athleteId, activityId });
    expect(res).toEqual({ ok: false, reason: "not_a_run" });
    const rows = await db
      .select()
      .from(activityAnalyses)
      .where(eq(activityAnalyses.activityId, activityId));
    expect(rows).toHaveLength(0);
  });

  test("LLM failure is non-fatal — objective stored, coachRead null", async () => {
    const { athleteId, activityId } = await seedRun({ sourceId: "a3" });
    // No canned response registered → mock throws → caught.
    const res = await analyzeActivity({ athleteId, activityId });
    expect(res).toEqual({ ok: true, coachRead: null });
    const [row] = await db
      .select()
      .from(activityAnalyses)
      .where(eq(activityAnalyses.activityId, activityId));
    expect(row?.coachRead).toBeNull();
    expect((row?.objective as { source?: string })?.source).toBe("splits");
  });

  test("upsert coexists with an existing feeling-only row (T4 landed first)", async () => {
    const { athleteId, activityId } = await seedRun({ sourceId: "a4" });
    const feeling = { effort: { rpe: 6, band: "moderate" }, verbatim: "felt fine" };
    await db.insert(activityAnalyses).values({ athleteId, activityId, feeling });
    mockProvider.setResponses([{ match: "coach's read", text: "Controlled run." }]);
    await analyzeActivity({ athleteId, activityId });
    const [row] = await db
      .select()
      .from(activityAnalyses)
      .where(eq(activityAnalyses.activityId, activityId));
    expect(row?.feeling).toEqual(feeling); // preserved
    expect(row?.coachRead).toBe("Controlled run."); // added
    expect((row?.objective as { source?: string })?.source).toBe("splits");
  });

  test("plan present → planned session passed to the read (matches on date)", async () => {
    const { athleteId, activityId } = await seedRun({ sourceId: "a5" });
    await saveAthletePlan(
      athleteId,
      parsePlan({
        source: "generated",
        start_date: "2026-06-08",
        weeks: [
          { index: 1, sessions: [{ day_of_week: "monday", type: "easy", description: "Easy 8K Z2" }] },
        ],
      }),
    );
    let sawPlanned = false;
    mockProvider.setResponses([
      { match: "Planned session today: easy", text: "On-plan easy run." },
    ]);
    const res = await analyzeActivity({ athleteId, activityId });
    sawPlanned = res.ok && res.coachRead === "On-plan easy run.";
    expect(sawPlanned).toBe(true);
  });
});
