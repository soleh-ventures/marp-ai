import { describe, expect, test } from "bun:test";
import {
  nearRateLimit,
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

describe("nearRateLimit", () => {
  test("true when short-window usage is at/over the margin", () => {
    const h = new Headers({ "x-ratelimit-usage": "95,500", "x-ratelimit-limit": "100,1000" });
    expect(nearRateLimit(h)).toBe(true);
  });
  test("true when daily usage is hot", () => {
    const h = new Headers({ "x-ratelimit-usage": "10,950", "x-ratelimit-limit": "100,1000" });
    expect(nearRateLimit(h)).toBe(true);
  });
  test("false with headroom", () => {
    const h = new Headers({ "x-ratelimit-usage": "10,100", "x-ratelimit-limit": "100,1000" });
    expect(nearRateLimit(h)).toBe(false);
  });
  test("false when headers absent", () => {
    expect(nearRateLimit(new Headers())).toBe(false);
  });
});
