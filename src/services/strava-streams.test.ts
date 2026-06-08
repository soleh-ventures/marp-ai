import { describe, expect, test } from "bun:test";
import {
  nearRateLimit,
  summarizeStreams,
  type StravaStreams,
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
