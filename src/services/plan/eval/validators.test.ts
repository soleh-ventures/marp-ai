import { describe, expect, test } from "bun:test";
import { runChecks } from "./validators.js";
import type { PlanFixture } from "./fixtures.js";
import type { Plan } from "../types.js";

// Helper — build a plan with sensible defaults and let each test
// override what it cares about. Keeps each test's intent legible.
function buildPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    version: 1,
    source: "generated",
    start_date: "2026-06-15",
    race_date: "2026-09-26",
    race_name: "Test Marathon",
    generated_at: new Date().toISOString(),
    weeks: [
      {
        index: 1,
        phase: "base",
        total_km: 30,
        focus: "build base",
        sessions: [
          { day_of_week: "monday", type: "rest", description: "Rest." },
          {
            day_of_week: "tuesday",
            type: "easy",
            distance_km: 6,
            description: "Easy 6km",
            reasoning: "Z2 aerobic base — 10%-rule build",
          },
          {
            day_of_week: "thursday",
            type: "tempo",
            distance_km: 8,
            description: "Tempo 8km",
            reasoning: "lactate threshold work",
          },
          {
            day_of_week: "sunday",
            type: "long",
            distance_km: 16,
            description: "Long 16km",
            reasoning: "aerobic base, glycogen depletion",
          },
        ],
      },
      {
        index: 2,
        phase: "taper",
        total_km: 18,
        focus: "race week",
        sessions: [
          { day_of_week: "monday", type: "rest", description: "Rest." },
          {
            day_of_week: "wednesday",
            type: "easy",
            distance_km: 5,
            description: "Easy 5km",
            reasoning: "Pfitz taper — freshness",
          },
          {
            day_of_week: "sunday",
            type: "race",
            distance_km: 42,
            description: "Race day.",
            reasoning: "race pace effort",
          },
        ],
      },
    ],
    ...overrides,
  };
}

const baseFixture: PlanFixture = {
  name: "test",
  memoryText: "",
  constraints: {},
};

describe("runChecks", () => {
  test("passes all five checks on a well-formed plan", () => {
    const plan = buildPlan();
    const result = runChecks(plan, baseFixture);
    expect(result.pass).toBe(true);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });

  test("fails structure when minWeeks not met", () => {
    const plan = buildPlan();
    const result = runChecks(plan, {
      ...baseFixture,
      constraints: { minWeeks: 16 },
    });
    const structure = result.checks.find((c) => c.id === "structure");
    expect(structure?.pass).toBe(false);
    expect(structure?.detail).toContain("expected ≥16");
  });

  test("fails taper when no taper phase and volume not declining", () => {
    const plan = buildPlan({
      weeks: [
        {
          index: 1,
          phase: "base",
          total_km: 30,
          sessions: [
            { day_of_week: "monday", type: "rest", description: "Rest." },
            {
              day_of_week: "tuesday",
              type: "easy",
              distance_km: 6,
              description: "Easy",
              reasoning: "Z2 base",
            },
          ],
        },
        {
          index: 2,
          phase: "build",
          total_km: 35,
          sessions: [
            { day_of_week: "monday", type: "rest", description: "Rest." },
            {
              day_of_week: "tuesday",
              type: "easy",
              distance_km: 8,
              description: "Easy",
              reasoning: "aerobic base",
            },
          ],
        },
      ],
    });
    const result = runChecks(plan, baseFixture);
    const taper = result.checks.find((c) => c.id === "taper");
    expect(taper?.pass).toBe(false);
  });

  test("taper check skipped when noRaceSession constraint set", () => {
    const plan = buildPlan({
      race_date: undefined,
      race_name: undefined,
      weeks: [
        {
          index: 1,
          phase: "base",
          total_km: 30,
          sessions: [
            { day_of_week: "monday", type: "rest", description: "Rest." },
            {
              day_of_week: "tuesday",
              type: "easy",
              distance_km: 6,
              description: "Easy",
              reasoning: "Z2 base",
            },
          ],
        },
      ],
    });
    const result = runChecks(plan, {
      ...baseFixture,
      constraints: { noRaceSession: true },
    });
    const taper = result.checks.find((c) => c.id === "taper");
    expect(taper?.pass).toBe(true);
    expect(taper?.detail).toContain("not required");
  });

  test("taper check passes via declining volume even without taper phase", () => {
    const plan = buildPlan({
      weeks: [
        {
          index: 1,
          phase: "build",
          total_km: 50,
          sessions: [
            { day_of_week: "monday", type: "rest", description: "Rest." },
            {
              day_of_week: "tuesday",
              type: "easy",
              distance_km: 10,
              description: "Easy",
              reasoning: "Z2 base",
            },
          ],
        },
        {
          index: 2,
          phase: "build",
          total_km: 40,
          sessions: [
            { day_of_week: "monday", type: "rest", description: "Rest." },
            {
              day_of_week: "tuesday",
              type: "easy",
              distance_km: 8,
              description: "Easy",
              reasoning: "Z2 base",
            },
          ],
        },
        {
          index: 3,
          phase: "peak",
          total_km: 28,
          sessions: [
            { day_of_week: "monday", type: "rest", description: "Rest." },
            {
              day_of_week: "tuesday",
              type: "easy",
              distance_km: 6,
              description: "Easy",
              reasoning: "Z2 base",
            },
          ],
        },
      ],
    });
    const result = runChecks(plan, baseFixture);
    const taper = result.checks.find((c) => c.id === "taper");
    expect(taper?.pass).toBe(true);
  });

  test("fails reasoning when LLM hallucinates a framework", () => {
    const plan = buildPlan({
      weeks: [
        {
          index: 1,
          phase: "base",
          sessions: [
            { day_of_week: "monday", type: "rest", description: "Rest." },
            {
              day_of_week: "tuesday",
              type: "easy",
              distance_km: 6,
              description: "Easy",
              reasoning: "based on the Roosevelt periodisation method",
            },
            {
              day_of_week: "thursday",
              type: "tempo",
              distance_km: 8,
              description: "Tempo",
              reasoning: "applying the Spinozian split-week framework",
            },
          ],
        },
      ],
    });
    const result = runChecks(plan, baseFixture);
    const reasoning = result.checks.find((c) => c.id === "reasoning_principles");
    expect(reasoning?.pass).toBe(false);
  });

  test("fails rest_days when a week has no rest", () => {
    const plan = buildPlan({
      weeks: [
        {
          index: 1,
          phase: "base",
          sessions: [
            {
              day_of_week: "monday",
              type: "easy",
              distance_km: 6,
              description: "Easy",
              reasoning: "Z2 base",
            },
            {
              day_of_week: "tuesday",
              type: "easy",
              distance_km: 6,
              description: "Easy",
              reasoning: "Z2 base",
            },
          ],
        },
      ],
    });
    const result = runChecks(plan, baseFixture);
    const rest = result.checks.find((c) => c.id === "rest_days");
    expect(rest?.pass).toBe(false);
    expect(rest?.detail).toContain("week");
  });

  test("fails constraints when long run exceeds cap", () => {
    const plan = buildPlan({
      weeks: [
        {
          index: 1,
          phase: "base",
          sessions: [
            { day_of_week: "monday", type: "rest", description: "Rest." },
            {
              day_of_week: "sunday",
              type: "long",
              distance_km: 40,
              description: "Long 40km",
              reasoning: "Z2 endurance",
            },
          ],
        },
      ],
    });
    const result = runChecks(plan, {
      ...baseFixture,
      constraints: { maxLongRunKm: 32 },
    });
    const constraints = result.checks.find((c) => c.id === "constraints");
    expect(constraints?.pass).toBe(false);
    expect(constraints?.detail).toContain("40");
  });

  test("fails constraints when training days exceed cap", () => {
    const plan = buildPlan({
      weeks: [
        {
          index: 1,
          phase: "base",
          sessions: [
            {
              day_of_week: "monday",
              type: "easy",
              distance_km: 5,
              description: "E",
              reasoning: "Z2 base",
            },
            {
              day_of_week: "tuesday",
              type: "easy",
              distance_km: 5,
              description: "E",
              reasoning: "Z2 base",
            },
            {
              day_of_week: "wednesday",
              type: "easy",
              distance_km: 5,
              description: "E",
              reasoning: "Z2 base",
            },
            {
              day_of_week: "thursday",
              type: "easy",
              distance_km: 5,
              description: "E",
              reasoning: "Z2 base",
            },
            {
              day_of_week: "friday",
              type: "easy",
              distance_km: 5,
              description: "E",
              reasoning: "Z2 base",
            },
            { day_of_week: "saturday", type: "rest", description: "Rest." },
          ],
        },
      ],
    });
    const result = runChecks(plan, {
      ...baseFixture,
      constraints: { maxDaysPerWeek: 4 },
    });
    const constraints = result.checks.find((c) => c.id === "constraints");
    expect(constraints?.pass).toBe(false);
    expect(constraints?.detail).toContain("exceed 4 training days");
  });

  test("constraints check honours mustInclude (cross-train)", () => {
    const planWithoutCross = buildPlan();
    const result1 = runChecks(planWithoutCross, {
      ...baseFixture,
      constraints: { mustInclude: ["cross"] },
    });
    expect(result1.checks.find((c) => c.id === "constraints")?.pass).toBe(false);

    const planWithCross = buildPlan({
      weeks: [
        {
          index: 1,
          phase: "base",
          sessions: [
            { day_of_week: "monday", type: "rest", description: "Rest." },
            {
              day_of_week: "wednesday",
              type: "cross",
              duration_min: 45,
              description: "Cycle 45min",
              reasoning: "preserve aerobic stimulus, off-load knee",
            },
          ],
        },
      ],
    });
    const result2 = runChecks(planWithCross, {
      ...baseFixture,
      constraints: { mustInclude: ["cross"] },
    });
    expect(result2.checks.find((c) => c.id === "constraints")?.pass).toBe(true);
  });

  test("a plan with 4/5 checks passing still passes overall (≥80% threshold)", () => {
    const plan = buildPlan({
      weeks: [
        {
          index: 1,
          phase: "base",
          sessions: [
            {
              day_of_week: "monday",
              type: "easy",
              distance_km: 5,
              description: "E",
              reasoning: "Z2 base",
            },
          ],
        },
      ],
    });
    // This plan fails rest_days but should still pass overall if 4/5 OK.
    const result = runChecks(plan, {
      ...baseFixture,
      constraints: { noRaceSession: true },
    });
    const passingCount = result.checks.filter((c) => c.pass).length;
    expect(passingCount).toBeGreaterThanOrEqual(4);
    expect(result.pass).toBe(true);
  });
});
