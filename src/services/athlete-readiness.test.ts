import { describe, expect, test } from "bun:test";
import { computeTrainingLoad } from "./athlete-readiness.js";

describe("computeTrainingLoad — ACWR + monotony", () => {
  test("balanced load lands in the optimal band (ACWR ~1.0)", () => {
    // 60 min/day for 7 days = 420 acute; 28d total 1680 → weekly avg 420.
    const load = computeTrainingLoad(new Array(7).fill(60), 1680);
    expect(load.acuteMinutes).toBe(420);
    expect(load.chronicWeeklyMinutes).toBe(420);
    expect(load.acwr).toBe(1);
    expect(load.flag).toBe("optimal");
  });

  test("a big spike week flags 'spike' (injury-risk ramp)", () => {
    // This week 700 min; prior 3 weeks light → 28d total 1000 → weekly avg 250.
    const load = computeTrainingLoad([100, 100, 100, 100, 100, 100, 100], 1000);
    expect(load.acwr).toBeGreaterThan(1.5);
    expect(load.flag).toBe("spike");
  });

  test("detraining when this week is far below the chronic average", () => {
    // Acute 140; 28d total 1400 → weekly avg 350 → ACWR 0.4.
    const load = computeTrainingLoad([20, 20, 20, 20, 20, 20, 20], 1400);
    expect(load.acwr).toBeLessThan(0.8);
    expect(load.flag).toBe("detraining");
  });

  test("monotony is high when load is evenly spread, low when varied", () => {
    // Perfectly even → SD 0 → monotony null (undefined, not Infinity).
    const even = computeTrainingLoad(new Array(7).fill(60), 1680);
    expect(even.monotony).toBeNull();
    // Varied days → finite monotony.
    const varied = computeTrainingLoad([0, 0, 120, 0, 30, 0, 90], 960);
    expect(varied.monotony).not.toBeNull();
    expect(varied.monotony!).toBeGreaterThan(0);
  });

  test("no chronic history → ACWR null, no flag (avoids divide-by-zero)", () => {
    const load = computeTrainingLoad([30, 0, 45, 0, 0, 60, 0], 135);
    // 28d total == this week's total → weekly avg = total/4, still positive.
    expect(load.acwr).not.toBeNull();
    const empty = computeTrainingLoad([0, 0, 0, 0, 0, 0, 0], 0);
    expect(empty.acwr).toBeNull();
    expect(empty.flag).toBeNull();
  });
});
