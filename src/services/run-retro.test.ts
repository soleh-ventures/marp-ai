import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { activities, activityAnalyses, athletes, planAdjustments, pendingDecisions } from "../db/schema.js";
import { _resetProviderCache, mockProvider } from "./llm/index.js";
import { saveAthletePlan } from "./plan/storage.js";
import { parsePlan } from "./plan/types.js";
import {
  computeWeekSignals,
  computeWeekStart,
  parseProposal,
  runWeeklyRetro,
  runWeeklyRetroSweep,
  weekSignalsWarrant,
} from "./run-retro.js";

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

const PROPOSAL_JSON = JSON.stringify({
  adjust: true,
  summary: "Ease next week back ~15%",
  rationale: "Two hard-effort runs + rising drift — cumulative fatigue, time to deload.",
  edit_request: "Reduce next week's volume ~15% and turn Thursday's tempo into an easy run.",
  decision_frame: {
    question: "Want me to ease next week back ~15%?",
    options: [
      { key: "accept", label: "Yes, ease it back" },
      { key: "keep", label: "Keep it as planned" },
    ],
  },
});

describe("computeWeekStart (pure)", () => {
  test("Sunday → that week's Monday", () => {
    expect(computeWeekStart("2026-06-14", "sunday")).toBe("2026-06-08");
  });
  test("Monday → itself", () => {
    expect(computeWeekStart("2026-06-08", "monday")).toBe("2026-06-08");
  });
});

describe("computeWeekSignals + weekSignalsWarrant (pure)", () => {
  test("counts hard efforts, energy, adherence, splits, drift", () => {
    const rows = [
      { coachRead: null, objective: { split_pattern: "positive", hr_drift_pct: 7 }, feeling: { effort: { rpe: 9, band: "hard" }, energy: "depleted", adherence: "cut_short", pain: { present: false } } },
      { coachRead: null, objective: { split_pattern: "even", hr_drift_pct: 2 }, feeling: { effort: { rpe: 8, band: "hard" }, energy: "low", adherence: "as_planned", pain: { present: false } } },
    ];
    const s = computeWeekSignals(rows, false);
    expect(s.runs).toBe(2);
    expect(s.hard_efforts).toBe(2);
    expect(s.avg_rpe).toBe(8.5);
    expect(s.low_energy).toBe(2);
    expect(s.cut_or_skipped).toBe(1);
    expect(s.positive_splits).toBe(1);
    expect(s.rising_hr_drift).toBe(1);
    expect(s.pain).toBe(false);
    expect(weekSignalsWarrant(s)).toBe(true); // 2 hard efforts
  });

  test("injury flag forces pain=true and warrants", () => {
    const s = computeWeekSignals([], true);
    expect(s.pain).toBe(true);
    expect(weekSignalsWarrant(s)).toBe(true);
  });

  test("a calm week does not warrant review", () => {
    const rows = [
      { coachRead: null, objective: { split_pattern: "even", hr_drift_pct: 1 }, feeling: { effort: { rpe: 4, band: "easy" }, energy: "positive", adherence: "as_planned", pain: { present: false } } },
    ];
    const s = computeWeekSignals(rows, false);
    expect(weekSignalsWarrant(s)).toBe(false);
  });
});

describe("parseProposal (pure)", () => {
  test("parses a valid adjust:true proposal", () => {
    const p = parseProposal(PROPOSAL_JSON)!;
    expect(p.summary).toContain("Ease");
    expect(p.edit_request).toContain("Thursday");
    expect(p.decision_frame.options).toHaveLength(2);
    expect(p.decision_frame.options[0]!.key).toBe("accept");
  });
  test("adjust:false → null", () => {
    expect(parseProposal('{"adjust": false}')).toBeNull();
  });
  test("missing edit_request → null", () => {
    expect(parseProposal(JSON.stringify({ adjust: true, summary: "x", rationale: "y", decision_frame: { question: "q", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] } }))).toBeNull();
  });
  test("fewer than 2 options → null", () => {
    expect(parseProposal(JSON.stringify({ adjust: true, summary: "x", rationale: "y", edit_request: "z", decision_frame: { question: "q", options: [{ key: "a", label: "A" }] } }))).toBeNull();
  });
  test("non-JSON → null", () => {
    expect(parseProposal("nope")).toBeNull();
  });
});

const basePlan = parsePlan({
  source: "generated",
  start_date: "2026-06-08",
  weeks: [
    {
      index: 1,
      sessions: [
        { day_of_week: "monday", type: "rest", description: "Rest" },
        { day_of_week: "thursday", type: "tempo", description: "Tempo 8K" },
        { day_of_week: "sunday", type: "long", description: "Long 20K" },
      ],
    },
  ],
});

async function seedAthlete(opts: { withPlan?: boolean; tz?: string } = {}) {
  const [a] = await db
    .insert(athletes)
    .values({
      phone: `+155516${Math.floor(Math.random() * 100000)}`,
      name: "Runner",
      timezone: opts.tz ?? "Europe/Berlin",
    })
    .returning();
  if (!a) throw new Error("athlete insert failed");
  if (opts.withPlan) await saveAthletePlan(a.id, basePlan);
  return a.id;
}

async function addHardRun(athleteId: string, sourceId: string) {
  const [act] = await db
    .insert(activities)
    .values({
      athleteId,
      discipline: "run",
      source: "strava",
      sourceId,
      startedAt: new Date(),
      durationS: 1800,
    })
    .returning();
  if (!act) throw new Error("activity insert failed");
  await db.insert(activityAnalyses).values({
    athleteId,
    activityId: act.id,
    objective: { split_pattern: "positive", hr_drift_pct: 8 },
    feeling: { effort: { rpe: 9, band: "hard" }, energy: "depleted", adherence: "as_planned", pain: { present: false } },
  });
}

describe("runWeeklyRetro (DB + mock LLM)", () => {
  test("no plan → no_plan, no LLM", async () => {
    const athleteId = await seedAthlete({ withPlan: false });
    const r = await runWeeklyRetro({ athleteId, weekStart: "2026-06-08", trigger: "weekly_sweep" });
    expect(r).toEqual({ proposed: false, reason: "no_plan" });
    expect(mockProvider.calls).toHaveLength(0);
  });

  test("stable week → stable_week, no LLM", async () => {
    const athleteId = await seedAthlete({ withPlan: true });
    const r = await runWeeklyRetro({ athleteId, weekStart: "2026-06-08", trigger: "weekly_sweep" });
    expect(r).toEqual({ proposed: false, reason: "stable_week" });
    expect(mockProvider.calls).toHaveLength(0);
  });

  test("warrants + LLM adjust → records proposal + pending_decision, gated send off", async () => {
    const athleteId = await seedAthlete({ withPlan: true });
    await addHardRun(athleteId, "r1");
    await addHardRun(athleteId, "r2");
    mockProvider.setResponses([{ match: "Decide whether to adjust", text: PROPOSAL_JSON }]);
    const r = await runWeeklyRetro({ athleteId, weekStart: "2026-06-08", trigger: "weekly_sweep" });
    expect(r.proposed).toBe(true);
    if (!r.proposed) throw new Error("expected proposed");
    expect(r.sent).toBe(false); // proactive outbound gated off in tests

    const [adj] = await db.select().from(planAdjustments).where(eq(planAdjustments.athleteId, athleteId));
    expect(adj?.status).toBe("proposed");
    expect(adj?.weekStart).toBe("2026-06-08");
    expect((adj?.proposal as { edit_request?: string })?.edit_request).toContain("Thursday");
    expect(adj?.pendingDecisionId).toBe(r.pendingDecisionId);

    const [pd] = await db.select().from(pendingDecisions).where(eq(pendingDecisions.id, r.pendingDecisionId));
    expect((pd?.frame as { question?: string })?.question).toContain("ease");
  });

  test("weekly idempotency → second sweep is already_proposed, only one row", async () => {
    const athleteId = await seedAthlete({ withPlan: true });
    await addHardRun(athleteId, "r1");
    await addHardRun(athleteId, "r2");
    mockProvider.setResponses([{ match: "Decide whether to adjust", text: PROPOSAL_JSON }]);
    await runWeeklyRetro({ athleteId, weekStart: "2026-06-08", trigger: "weekly_sweep" });
    const r2 = await runWeeklyRetro({ athleteId, weekStart: "2026-06-08", trigger: "weekly_sweep" });
    expect(r2).toEqual({ proposed: false, reason: "already_proposed" });
    const rows = await db.select().from(planAdjustments).where(eq(planAdjustments.athleteId, athleteId));
    expect(rows).toHaveLength(1);
  });

  test("LLM declines (adjust:false) → llm_no_change, no records", async () => {
    const athleteId = await seedAthlete({ withPlan: true });
    await addHardRun(athleteId, "r1");
    await addHardRun(athleteId, "r2");
    mockProvider.setResponses([{ match: "Decide whether to adjust", text: '{"adjust": false}' }]);
    const r = await runWeeklyRetro({ athleteId, weekStart: "2026-06-08", trigger: "weekly_sweep" });
    expect(r).toEqual({ proposed: false, reason: "llm_no_change" });
    const rows = await db.select().from(planAdjustments).where(eq(planAdjustments.athleteId, athleteId));
    expect(rows).toHaveLength(0);
  });

  test("event trigger is skipped when a proposal is already open (anti-spam)", async () => {
    const athleteId = await seedAthlete({ withPlan: true });
    await db.insert(planAdjustments).values({
      athleteId,
      trigger: "event",
      weekStart: "2026-06-08",
      proposal: { summary: "x", rationale: "y", edit_request: "z", decision_frame: { question: "q", options: [] } },
      status: "proposed",
    });
    const r = await runWeeklyRetro({ athleteId, weekStart: "2026-06-08", trigger: "event" });
    expect(r).toEqual({ proposed: false, reason: "recent_proposal" });
  });
});

describe("runWeeklyRetroSweep", () => {
  test("proposes for a Sunday athlete with a warranting week", async () => {
    const athleteId = await seedAthlete({ withPlan: true, tz: "Europe/Berlin" });
    await addHardRun(athleteId, "r1");
    await addHardRun(athleteId, "r2");
    mockProvider.setResponses([{ match: "Decide whether to adjust", text: PROPOSAL_JSON }]);
    // 2026-06-14 17:00Z = Sunday 19:00 in Berlin (summer, UTC+2).
    const stats = await runWeeklyRetroSweep({ now: new Date("2026-06-14T17:00:00Z") });
    expect(stats.eligible).toBeGreaterThanOrEqual(1);
    expect(stats.proposed).toBe(1);
  });

  test("skips when it is not Sunday locally", async () => {
    const athleteId = await seedAthlete({ withPlan: true, tz: "Europe/Berlin" });
    await addHardRun(athleteId, "r1");
    const stats = await runWeeklyRetroSweep({ now: new Date("2026-06-10T17:00:00Z") }); // Wednesday
    expect(stats.eligible).toBe(0);
    expect(stats.proposed).toBe(0);
    expect(mockProvider.calls).toHaveLength(0);
  });
});
