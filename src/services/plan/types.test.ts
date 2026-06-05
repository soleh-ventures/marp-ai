import { describe, expect, test } from "bun:test";
import { parsePlan, renderPlanSummary } from "./types.js";

const validPlan = {
  source: "generated",
  start_date: "2026-06-08",
  race_date: "2026-09-27",
  race_name: "Berlin Marathon",
  weeks: [
    {
      index: 1,
      phase: "base",
      total_km: 35,
      focus: "Settle into rhythm",
      sessions: [
        { day_of_week: "monday", type: "rest", description: "Rest day" },
        {
          day_of_week: "tuesday",
          type: "easy",
          distance_km: 6,
          description: "6K easy Z2",
          reasoning: "Base aerobic, 10%-rule build",
        },
        {
          day_of_week: "saturday",
          type: "long",
          distance_km: 14,
          description: "14K long run, conversational",
          reasoning: "Long run = race-distance familiarity",
        },
      ],
    },
  ],
};

describe("parsePlan — happy path", () => {
  test("accepts a well-formed plan and returns it normalised", () => {
    const plan = parsePlan(validPlan);
    expect(plan.version).toBe(1);
    expect(plan.source).toBe("generated");
    expect(plan.weeks).toHaveLength(1);
    expect(plan.weeks[0]?.sessions).toHaveLength(3);
    expect(plan.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("defaults source to 'generated' when not provided", () => {
    const plan = parsePlan({ ...validPlan, source: undefined });
    expect(plan.source).toBe("generated");
  });

  test("normalises day_of_week to lowercase", () => {
    const plan = parsePlan({
      ...validPlan,
      weeks: [
        {
          index: 1,
          sessions: [
            { day_of_week: "TUESDAY", type: "easy", description: "Easy 6K" },
          ],
        },
      ],
    });
    expect(plan.weeks[0]?.sessions[0]?.day_of_week).toBe("tuesday");
  });

  test("coerces unknown session type to easy (LLM vocabulary drift)", () => {
    const plan = parsePlan({
      ...validPlan,
      weeks: [
        {
          index: 1,
          sessions: [
            { day_of_week: "monday", type: "fartlek", description: "Fartlek 8K" },
          ],
        },
      ],
    });
    expect(plan.weeks[0]?.sessions[0]?.type).toBe("easy");
  });
});

describe("parsePlan — rejection", () => {
  test("rejects non-object root", () => {
    expect(() => parsePlan("not an object")).toThrow();
  });

  test("rejects when weeks is not an array", () => {
    expect(() => parsePlan({ ...validPlan, weeks: "nope" })).toThrow();
  });

  test("rejects when weeks is empty", () => {
    expect(() => parsePlan({ ...validPlan, weeks: [] })).toThrow();
  });

  test("rejects session without day_of_week", () => {
    expect(() =>
      parsePlan({
        ...validPlan,
        weeks: [
          { index: 1, sessions: [{ type: "easy", description: "5K easy" }] },
        ],
      }),
    ).toThrow();
  });

  test("rejects session without description", () => {
    expect(() =>
      parsePlan({
        ...validPlan,
        weeks: [
          {
            index: 1,
            sessions: [{ day_of_week: "monday", type: "easy", description: "" }],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("renderPlanSummary", () => {
  test("includes the race name, week count, and a peak-week line", () => {
    const plan = parsePlan(validPlan);
    const summary = renderPlanSummary(plan);
    expect(summary).toContain("Berlin Marathon");
    expect(summary).toContain("1-week plan");
    expect(summary).toContain("Peak week");
  });

  test("ends with a 'tell me what to change' nudge so the runner knows they can revise", () => {
    const plan = parsePlan(validPlan);
    const summary = renderPlanSummary(plan);
    expect(summary).toMatch(/change/);
  });

  test("omits race name line when not provided", () => {
    const plan = parsePlan({ ...validPlan, race_name: undefined });
    const summary = renderPlanSummary(plan);
    expect(summary).not.toContain("Berlin");
  });

  test("F6: leads with the methodology when present", () => {
    const plan = parsePlan({
      ...validPlan,
      methodology: "Pfitz base→build→peak→taper, 80/20 polarized, 10%-rule",
    });
    const summary = renderPlanSummary(plan);
    expect(summary).toContain("Built on: Pfitz");
  });

  test("F6: omits the methodology line when absent", () => {
    const plan = parsePlan(validPlan);
    expect(renderPlanSummary(plan)).not.toContain("Built on:");
  });
});
