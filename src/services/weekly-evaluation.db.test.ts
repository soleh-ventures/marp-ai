import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { athletes, weeklyEvaluations } from "../db/schema.js";
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
