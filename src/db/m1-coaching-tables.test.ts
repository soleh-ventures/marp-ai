import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "./client.js";
import { assertNotProductionDb } from "./test-guard.js";
import {
  activities,
  activityAnalyses,
  athletes,
  pendingDecisions,
  planAdjustments,
} from "./schema.js";

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

// `key` varies the phone + Strava source_id so a single test can seed more
// than one athlete/activity without tripping the unique indexes on
// athletes.phone and activities.(source, source_id).
async function seedAthleteWithActivity(key = "0") {
  const [a] = await db
    .insert(athletes)
    .values({ phone: `+15551110${key}`, name: `M1 Tester ${key}` })
    .returning();
  if (!a) throw new Error("athlete insert failed");
  const [act] = await db
    .insert(activities)
    .values({
      athleteId: a.id,
      discipline: "run",
      source: "strava",
      sourceId: `strava-${key}`,
      startedAt: new Date("2026-06-06T07:00:00Z"),
      durationS: 3600,
      metrics: { distance_m: 12000, avg_hr: 152 },
    })
    .returning();
  if (!act) throw new Error("activity insert failed");
  return { athlete: a, activity: act };
}

const SAMPLE_OBJECTIVE = {
  per_km: [{ km: 1, pace_s: 340 }],
  split_drift_pct: 3.2,
};
const SAMPLE_FEELING = {
  effort: { rpe: 7, band: "moderate" },
  energy: "low",
  pain: { present: false },
  adherence: "as_planned",
  context: "slept badly",
  verbatim: "legs were dead, maybe a 7",
};

describe("activity_analyses schema (M1 — KER-60)", () => {
  test("round-trips objective + feeling + coachRead jsonb", async () => {
    const { athlete, activity } = await seedAthleteWithActivity();
    const [row] = await db
      .insert(activityAnalyses)
      .values({
        athleteId: athlete.id,
        activityId: activity.id,
        objective: SAMPLE_OBJECTIVE,
        feeling: SAMPLE_FEELING,
        coachRead: "Solid Z2, slight late drift — fatigue tracks the bad sleep.",
      })
      .returning();
    expect(row?.objective).toEqual(SAMPLE_OBJECTIVE);
    expect(row?.feeling).toEqual(SAMPLE_FEELING);
    expect(row?.coachRead).toContain("Z2");
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  test("allows a feeling-only row (analysis decoupled, decision 4A)", async () => {
    const { athlete, activity } = await seedAthleteWithActivity();
    const [row] = await db
      .insert(activityAnalyses)
      .values({
        athleteId: athlete.id,
        activityId: activity.id,
        feeling: SAMPLE_FEELING,
      })
      .returning();
    expect(row?.objective).toBeNull();
    expect(row?.feeling).toEqual(SAMPLE_FEELING);
    expect(row?.coachRead).toBeNull();
  });

  test("enforces one analysis per activity (unique activity_id)", async () => {
    const { athlete, activity } = await seedAthleteWithActivity();
    await db.insert(activityAnalyses).values({
      athleteId: athlete.id,
      activityId: activity.id,
      objective: SAMPLE_OBJECTIVE,
    });
    await expect(
      (async () => {
        await db.insert(activityAnalyses).values({
          athleteId: athlete.id,
          activityId: activity.id,
          feeling: SAMPLE_FEELING,
        });
      })(),
    ).rejects.toThrow();
  });

  test("cascades on athlete delete AND on activity delete", async () => {
    const { athlete, activity } = await seedAthleteWithActivity();
    await db.insert(activityAnalyses).values({
      athleteId: athlete.id,
      activityId: activity.id,
      objective: SAMPLE_OBJECTIVE,
    });
    // Deleting the activity removes its analysis.
    await db.delete(activities).where(eq(activities.id, activity.id));
    expect(
      await db
        .select()
        .from(activityAnalyses)
        .where(eq(activityAnalyses.athleteId, athlete.id)),
    ).toEqual([]);

    // And athlete-level erasure cascades too.
    const { athlete: a2, activity: act2 } = await seedAthleteWithActivity("2");
    await db.insert(activityAnalyses).values({
      athleteId: a2.id,
      activityId: act2.id,
      objective: SAMPLE_OBJECTIVE,
    });
    await db.delete(athletes).where(eq(athletes.id, a2.id));
    expect(
      await db
        .select()
        .from(activityAnalyses)
        .where(eq(activityAnalyses.athleteId, a2.id)),
    ).toEqual([]);
  });
});

const SAMPLE_PROPOSAL = {
  question: "Ease next week?",
  rationale: "3 high-RPE runs + rising drift",
  diff: [{ week: 2, change: "drop tempo to easy" }],
};

describe("plan_adjustments schema (M1 — KER-60)", () => {
  test("inserts a proposal with status defaulting to 'proposed'", async () => {
    const { athlete } = await seedAthleteWithActivity();
    const [row] = await db
      .insert(planAdjustments)
      .values({
        athleteId: athlete.id,
        trigger: "weekly_sweep",
        weekStart: "2026-06-08",
        proposal: SAMPLE_PROPOSAL,
      })
      .returning();
    expect(row?.status).toBe("proposed");
    expect(row?.proposal).toEqual(SAMPLE_PROPOSAL);
    expect(row?.appliedAt).toBeNull();
  });

  test("weekly idempotency: one weekly_sweep per (athlete, week)", async () => {
    const { athlete } = await seedAthleteWithActivity();
    await db.insert(planAdjustments).values({
      athleteId: athlete.id,
      trigger: "weekly_sweep",
      weekStart: "2026-06-08",
      proposal: SAMPLE_PROPOSAL,
    });
    // Second weekly sweep for the same week is blocked by the partial unique index.
    await expect(
      (async () => {
        await db.insert(planAdjustments).values({
          athleteId: athlete.id,
          trigger: "weekly_sweep",
          weekStart: "2026-06-08",
          proposal: SAMPLE_PROPOSAL,
        });
      })(),
    ).rejects.toThrow();
  });

  test("event-driven proposals are exempt from the weekly unique index", async () => {
    const { athlete } = await seedAthleteWithActivity();
    await db.insert(planAdjustments).values({
      athleteId: athlete.id,
      trigger: "weekly_sweep",
      weekStart: "2026-06-08",
      proposal: SAMPLE_PROPOSAL,
    });
    // Two event proposals in the same week must both succeed (real mid-week
    // signals can fire more than once) — the partial index only covers
    // trigger = 'weekly_sweep'.
    await db.insert(planAdjustments).values({
      athleteId: athlete.id,
      trigger: "event",
      weekStart: "2026-06-08",
      proposal: SAMPLE_PROPOSAL,
    });
    await db.insert(planAdjustments).values({
      athleteId: athlete.id,
      trigger: "event",
      weekStart: "2026-06-08",
      proposal: SAMPLE_PROPOSAL,
    });
    const rows = await db
      .select()
      .from(planAdjustments)
      .where(eq(planAdjustments.athleteId, athlete.id));
    expect(rows).toHaveLength(3);
  });

  test("pending_decision_id SET NULL on decision delete — adjustment survives", async () => {
    const { athlete } = await seedAthleteWithActivity();
    const [decision] = await db
      .insert(pendingDecisions)
      .values({
        athleteId: athlete.id,
        frame: { question: "Ease next week?", options: [{ key: "yes", label: "Yes" }] },
      })
      .returning();
    if (!decision) throw new Error("decision insert failed");
    await db.insert(planAdjustments).values({
      athleteId: athlete.id,
      trigger: "weekly_sweep",
      weekStart: "2026-06-08",
      proposal: SAMPLE_PROPOSAL,
      pendingDecisionId: decision.id,
    });
    await db.delete(pendingDecisions).where(eq(pendingDecisions.id, decision.id));
    const surviving = await db
      .select()
      .from(planAdjustments)
      .where(eq(planAdjustments.athleteId, athlete.id));
    expect(surviving).toHaveLength(1);
    expect(surviving[0]?.pendingDecisionId).toBeNull();
  });
});
