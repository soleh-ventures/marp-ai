import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { activities, athletes, weeklyEvaluations } from "../db/schema.js";
import { getAthleticHistory } from "../flows/onboarding.js";
import { _resetProviderCache, mockProvider } from "./llm/index.js";
import { getStoredPlan } from "./plan/storage.js";
import type { Plan } from "./plan/types.js";
import {
  revertLastWeeklyAdjustment,
  runWeeklyEvaluationForAthlete,
} from "./weekly-evaluation.js";

function makePlan(startDate: string, longKm: number): Plan {
  return {
    version: 1,
    source: "generated",
    start_date: startDate,
    weeks: [
      {
        index: 1,
        sessions: [
          { day_of_week: "saturday", type: "long", distance_km: longKm, description: `Long ${longKm}k` },
        ],
      },
    ],
    generated_at: `${startDate}T00:00:00Z`,
  };
}

let prevProvider: string;

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`TRUNCATE TABLE weekly_evaluations, activities, athletes RESTART IDENTITY CASCADE`);
  prevProvider = config.llm.provider;
  (config.llm as { provider: string }).provider = "mock";
  _resetProviderCache();
  mockProvider.reset();
});

afterEach(() => {
  (config.llm as { provider: string }).provider = prevProvider;
  _resetProviderCache();
});

async function seedAthlete(plan: Plan): Promise<string> {
  const [a] = await db
    .insert(athletes)
    .values({ phone: "+15557778888", name: "Eval", timezone: "Europe/Berlin", athleticHistory: { plan } })
    .returning();
  if (!a) throw new Error("insert failed");
  return a.id;
}

describe("runWeeklyEvaluationForAthlete (DB)", () => {
  test("no-adjust week: records one evaluation row, idempotent", async () => {
    const id = await seedAthlete(makePlan("2026-06-08", 10));
    mockProvider.setResponses([
      { match: /.*/, text: '{"evaluation":"Solid, on track — keep it up.","adjust":false}' },
    ]);

    const r1 = await runWeeklyEvaluationForAthlete({ athleteId: id, weekStart: "2026-06-08" });
    expect(r1.ran).toBe(true);
    if (r1.ran) {
      expect(r1.status).toBe("evaluated");
      expect(r1.adjusted).toBe(false);
      expect(r1.sent).toBe(false); // outbound gated off in tests
    }

    const rows = await db
      .select({ id: weeklyEvaluations.id, status: weeklyEvaluations.status })
      .from(weeklyEvaluations)
      .where(eq(weeklyEvaluations.athleteId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("evaluated");

    // Second run collapses — one evaluation per athlete-week.
    const r2 = await runWeeklyEvaluationForAthlete({ athleteId: id, weekStart: "2026-06-08" });
    expect(r2.ran).toBe(false);
    if (!r2.ran) expect(r2.reason).toBe("already_done");
  });

  test("evaluates the week the runner last trained in, not today's empty week", async () => {
    // Dates relative to NOW (buildWeeklyEvaluation uses real now): a 4-week
    // plan whose week 1 is ~2 weeks ago. The only activity is in week 1 (still
    // inside the 21-day load window). Today falls in week 3. OLD behavior would
    // evaluate week 3 (today); the fix anchors to the latest activity → week 1.
    const day = 86400000;
    const base = new Date(Date.now() - 15 * day);
    const dow = base.getUTCDay(); // 0=Sun..6=Sat
    const monday = new Date(base.getTime() - ((dow + 6) % 7) * day); // Monday of that week
    const startISO = monday.toISOString().slice(0, 10);
    const actDate = new Date(monday.getTime() + 2 * day); // Wed of week 1

    const weeks = Array.from({ length: 4 }, (_, i) => ({
      index: i + 1,
      sessions: [{ day_of_week: "wednesday" as const, type: "easy" as const, distance_km: 6, description: "Easy 6k" }],
    }));
    const fourWk: Plan = { version: 1, source: "generated", start_date: startISO, weeks, generated_at: "2026-01-01T00:00:00Z" };
    const [a] = await db
      .insert(athletes)
      .values({ phone: "+15550009999", name: "Anchor", timezone: "Europe/Berlin", athleticHistory: { plan: fourWk } })
      .returning();
    if (!a) throw new Error("insert failed");
    await db.insert(activities).values({
      athleteId: a.id,
      discipline: "run",
      source: "strava",
      sourceId: "anchor-1",
      startedAt: actDate,
      durationS: 36 * 60,
      metrics: { distance_m: 6000 },
    });
    mockProvider.setResponses([{ match: /.*/, text: '{"evaluation":"Week 1 done.","adjust":false}' }]);

    await runWeeklyEvaluationForAthlete({ athleteId: a.id, weekStart: startISO });
    const [row] = await db
      .select({ weekIndex: weeklyEvaluations.weekIndex })
      .from(weeklyEvaluations)
      .where(eq(weeklyEvaluations.athleteId, a.id))
      .limit(1);
    expect(row?.weekIndex).toBe(1); // anchored to the week-1 activity, not today's week (3)
  });

  test("safety_hold: proposes, never auto-applies the plan", async () => {
    const id = await seedAthlete(makePlan("2026-06-08", 10));
    mockProvider.setResponses([
      {
        match: /.*/,
        text: '{"evaluation":"That knee pain matters.","adjust":true,"safety_hold":true,"change_summary":"back off volume","rationale":"pain three runs running","edit_request":""}',
      },
    ]);
    const r = await runWeeklyEvaluationForAthlete({ athleteId: id, weekStart: "2026-06-08" });
    expect(r.ran).toBe(true);
    if (r.ran) expect(r.status).toBe("proposed");
    // Plan unchanged (still the seeded 10k long run).
    const [row] = await db.select({ ah: athletes.athleticHistory }).from(athletes).where(eq(athletes.id, id)).limit(1);
    const plan = getStoredPlan(getAthleticHistory(row?.ah));
    expect(plan?.weeks[0]?.sessions[0]?.distance_km).toBe(10);
  });
});

describe("revertLastWeeklyAdjustment", () => {
  test("restores the pre-change plan snapshot and marks it reverted", async () => {
    const before = makePlan("2026-06-08", 16); // original
    const after = makePlan("2026-06-08", 12); // coach-applied (eased)
    const id = await seedAthlete(after); // current stored plan is the eased one
    await db.insert(weeklyEvaluations).values({
      athleteId: id,
      weekStart: "2026-06-08",
      evaluation: "Eased your long run.",
      adjusted: true,
      changeSummary: "long run 16k → 12k",
      beforePlan: before,
      afterPlan: after,
      status: "applied",
    });

    const msg = await revertLastWeeklyAdjustment(id);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/put your plan back/i);

    const [row] = await db.select({ ah: athletes.athleticHistory }).from(athletes).where(eq(athletes.id, id)).limit(1);
    const plan = getStoredPlan(getAthleticHistory(row?.ah));
    expect(plan?.weeks[0]?.sessions[0]?.distance_km).toBe(16); // restored to original

    const [ev] = await db
      .select({ status: weeklyEvaluations.status })
      .from(weeklyEvaluations)
      .where(eq(weeklyEvaluations.athleteId, id))
      .limit(1);
    expect(ev?.status).toBe("reverted");
  });

  test("returns null when there's nothing to revert", async () => {
    const id = await seedAthlete(makePlan("2026-06-08", 10));
    expect(await revertLastWeeklyAdjustment(id)).toBeNull();
  });
});
