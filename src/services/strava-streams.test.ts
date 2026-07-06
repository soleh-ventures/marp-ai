import { describe, expect, test } from "bun:test";
import {
  renderDeepStreamDetail,
  renderStreamAnnotation,
  summarizeStreams,
  type StravaStreams,
  type StreamSummary,
} from "./strava-streams.js";

// A 2km run sampled every 60s. km1 takes 300s, km2 takes 240s (sped up =
// negative split); HR rises through the run (positive cardiac drift).
function negativeSplitRun(withHr = true): StravaStreams {
  const s: StravaStreams = {
    time: { data: [0, 60, 120, 180, 240, 300, 360, 420, 480, 540] },
    distance: { data: [0, 150, 350, 550, 750, 1000, 1300, 1600, 1850, 2000] },
  };
  if (withHr) s.heartrate = { data: [140, 145, 150, 150, 152, 155, 158, 160, 162, 165] };
  return s;
}

describe("summarizeStreams", () => {
  test("computes km splits, negative split pattern, and HR drift", () => {
    const sum = summarizeStreams(negativeSplitRun());
    expect(sum).not.toBeNull();
    if (!sum) return;
    expect(sum.km_splits).toHaveLength(2);
    expect(sum.km_splits[0]?.pace_s_per_km).toBe(300);
    expect(sum.km_splits[1]?.pace_s_per_km).toBe(240);
    expect(sum.split_pattern).toBe("negative");
    expect(sum.hr_drift_pct).not.toBeNull();
    expect(sum.hr_drift_pct! > 0).toBe(true); // HR rose
    expect(sum.avg_hr).not.toBeNull();
    expect(sum.max_hr).toBe(165);
    expect(sum.total_distance_m).toBe(2000);
    expect(sum.total_time_s).toBe(540);
  });

  test("no heartrate channel → HR fields null, splits still computed", () => {
    const sum = summarizeStreams(negativeSplitRun(false));
    expect(sum).not.toBeNull();
    if (!sum) return;
    expect(sum.km_splits).toHaveLength(2);
    expect(sum.avg_hr).toBeNull();
    expect(sum.hr_drift_pct).toBeNull();
    expect(sum.km_splits[0]?.avg_hr).toBeNull();
  });

  test("positive split is detected (slowed down)", () => {
    const s: StravaStreams = {
      time: { data: [0, 60, 120, 180, 240, 300, 420, 540] },
      // 1000m by t=240 (fast first km), 2000m by t=540 (slow second km)
      distance: { data: [0, 250, 500, 750, 1000, 1300, 1650, 2000] },
    };
    expect(summarizeStreams(s)?.split_pattern).toBe("positive");
  });

  test("missing distance stream → null (can't split)", () => {
    expect(summarizeStreams({ time: { data: [0, 60, 120] } })).toBeNull();
  });

  test("empty / malformed → null", () => {
    expect(summarizeStreams({})).toBeNull();
    expect(summarizeStreams({ time: { data: [] }, distance: { data: [] } })).toBeNull();
  });
});

describe("renderStreamAnnotation", () => {
  const base: StreamSummary = {
    km_splits: [
      { km: 1, pace_s_per_km: 300, avg_hr: 150 },
      { km: 2, pace_s_per_km: 270, avg_hr: 160 },
    ],
    split_pattern: "negative",
    hr_drift_pct: 6.5,
    avg_hr: 155,
    max_hr: 165,
    total_distance_m: 2000,
    total_time_s: 570,
  };

  test("names split pattern, HR drift, and km range", () => {
    const out = renderStreamAnnotation(base);
    expect(out).toContain("negative split");
    expect(out).toContain("HR drift +6.5%");
    expect(out).toContain("km 4:30–5:00");
  });

  test("omits even split and sub-threshold drift", () => {
    const out = renderStreamAnnotation({ ...base, split_pattern: "even", hr_drift_pct: 1 });
    expect(out).not.toContain("split");
    expect(out).not.toContain("HR drift");
    expect(out).toContain("km"); // still shows the range
  });
});

// A run with per-sample cadence + altitude so the deep channels compute.
function runWithDeepChannels(): StravaStreams {
  return {
    time: { data: [0, 60, 120, 180, 240, 300, 360, 420, 480, 540] },
    distance: { data: [0, 150, 350, 550, 750, 1000, 1300, 1600, 1850, 2000] },
    heartrate: { data: [140, 145, 150, 150, 152, 155, 158, 160, 162, 165] },
    cadence: { data: [170, 172, 171, 173, 170, 172, 171, 170, 172, 171] },
    altitude: { data: [100, 105, 110, 108, 112, 118, 115, 120, 122, 125] },
  };
}

describe("summarizeStreams — deep channels (Garmin)", () => {
  test("cadence CV, elevation gain/loss come from the streams", () => {
    const sum = summarizeStreams(runWithDeepChannels());
    expect(sum).not.toBeNull();
    if (!sum) return;
    expect(sum.cadence).toBeDefined();
    expect(sum.cadence!.avg).toBe(171);
    // Metronomic cadence → tiny CV.
    expect(sum.cadence!.stability_cv).not.toBeNull();
    expect(sum.cadence!.stability_cv! < 0.05).toBe(true);
    // Altitude rises net +25m with a couple of dips (loss > 0).
    expect(sum.elev_gain_m! > sum.elev_loss_m!).toBe(true);
    expect(sum.elev_loss_m! > 0).toBe(true);
  });

  test("laps + hr_zone_seconds extras flow into the summary with pct", () => {
    const sum = summarizeStreams(runWithDeepChannels(), {
      laps: [
        { index: 1, distance_m: 1000, time_s: 300, avg_hr: 148, avg_pace_s_per_km: 300 },
        { index: 2, distance_m: 1000, time_s: 240, avg_hr: 160, avg_pace_s_per_km: 240 },
      ],
      hr_zone_seconds: [
        { zone: 1, seconds: 60 },
        { zone: 2, seconds: 300 },
        { zone: 3, seconds: 180 },
      ],
    });
    expect(sum).not.toBeNull();
    if (!sum) return;
    expect(sum.laps).toHaveLength(2);
    expect(sum.hr_zones).toHaveLength(3);
    // 300/540 total → ~55.6% in Z2.
    const z2 = sum.hr_zones!.find((z) => z.zone === 2)!;
    expect(z2.pct).toBeGreaterThan(50);
    expect(z2.pct).toBeLessThan(60);
    // pct across zones sums to ~100.
    const totalPct = sum.hr_zones!.reduce((a, z) => a + z.pct, 0);
    expect(Math.abs(totalPct - 100)).toBeLessThan(0.5);
  });

  test("no extras + no cadence/altitude → deep fields stay absent", () => {
    const sum = summarizeStreams(negativeSplitRun());
    expect(sum).not.toBeNull();
    if (!sum) return;
    expect(sum.laps).toBeUndefined();
    expect(sum.hr_zones).toBeUndefined();
    expect(sum.cadence).toBeUndefined();
    expect(sum.elev_gain_m).toBeUndefined();
  });
});

describe("renderDeepStreamDetail", () => {
  const deep: StreamSummary = {
    km_splits: [
      { km: 1, pace_s_per_km: 300, avg_hr: 148 },
      { km: 2, pace_s_per_km: 240, avg_hr: 160 },
    ],
    split_pattern: "negative",
    hr_drift_pct: 6.5,
    avg_hr: 154,
    max_hr: 165,
    total_distance_m: 2000,
    total_time_s: 540,
    laps: [
      { index: 1, distance_m: 1000, time_s: 300, avg_hr: 148, avg_pace_s_per_km: 300 },
      { index: 2, distance_m: 1000, time_s: 240, avg_hr: 160, avg_pace_s_per_km: 240 },
    ],
    hr_zones: [
      { zone: 2, seconds: 300, pct: 55.6 },
      { zone: 3, seconds: 240, pct: 44.4 },
    ],
    cadence: { avg: 171, stability_cv: 0.01 },
    elev_gain_m: 40,
    elev_loss_m: 15,
  };

  test("renders every deep section as its own line", () => {
    const out = renderDeepStreamDetail(deep);
    expect(out).toContain("Distance 2.00km");
    expect(out).toContain("avg HR 154/max 165");
    expect(out).toContain("Split pattern: negative, cardiac drift +6.5%");
    expect(out).toContain("Per-km: 1:5:00@148"); // 300s = 5:00
    expect(out).toContain("Laps: L1");
    expect(out).toContain("HR zones: Z2 55.6%");
    expect(out).toContain("Cadence: 171spm (CV 0.01)");
    expect(out).toContain("Elevation: +40m / -15m");
    // Multi-line — each section on its own row.
    expect(out.split("\n").length).toBeGreaterThanOrEqual(6);
  });

  test("omits deep sections that are absent (Strava-shaped row)", () => {
    const out = renderDeepStreamDetail({
      km_splits: deep.km_splits,
      split_pattern: "even",
      hr_drift_pct: null,
      avg_hr: 154,
      max_hr: 165,
      total_distance_m: 2000,
      total_time_s: 540,
    });
    expect(out).toContain("Per-km:");
    expect(out).not.toContain("Laps:");
    expect(out).not.toContain("HR zones:");
    expect(out).not.toContain("Cadence:");
    expect(out).not.toContain("Elevation:");
    expect(out).not.toContain("cardiac drift");
  });
});

describe("HR drift halves are non-overlapping", () => {
  test("a flat-HR run reads ~0 drift (no boundary double-count)", () => {
    const s: StravaStreams = {
      time: { data: [0, 60, 120, 180, 240, 300] },
      distance: { data: [0, 200, 400, 600, 800, 1000] },
      heartrate: { data: [150, 150, 150, 150, 150, 150] },
    };
    expect(summarizeStreams(s)?.hr_drift_pct).toBe(0);
  });
});
