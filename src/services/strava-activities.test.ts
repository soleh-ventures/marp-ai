import { describe, expect, test } from "bun:test";
import {
  mapSportType,
  normalizeStravaActivity,
  type StravaActivity,
} from "./strava-activities.js";

const baseActivity: StravaActivity = {
  id: 9876543210,
  name: "Morning Run",
  sport_type: "Run",
  start_date: "2026-05-27T06:30:00Z",
  moving_time: 3600,
  elapsed_time: 3700,
  distance: 10_000,
  total_elevation_gain: 50,
  average_heartrate: 152,
  max_heartrate: 178,
  average_cadence: 88,
  calories: 720,
};

describe("mapSportType", () => {
  test("collapses running variants to 'run'", () => {
    expect(mapSportType("Run")).toBe("run");
    expect(mapSportType("TrailRun")).toBe("run");
    expect(mapSportType("VirtualRun")).toBe("run");
  });

  test("maps cycling variants to 'ride'", () => {
    expect(mapSportType("Ride")).toBe("ride");
    expect(mapSportType("GravelRide")).toBe("ride");
    expect(mapSportType("MountainBikeRide")).toBe("ride");
  });

  test("falls through to 'other' for unknown", () => {
    expect(mapSportType("Surfing")).toBe("other");
    expect(mapSportType(undefined)).toBe("other");
  });
});

describe("normalizeStravaActivity", () => {
  test("happy-path Run produces expected shape", () => {
    const n = normalizeStravaActivity(baseActivity);
    expect(n.discipline).toBe("run");
    expect(n.source).toBe("strava");
    expect(n.sourceId).toBe("9876543210");
    expect(n.startedAt.toISOString()).toBe("2026-05-27T06:30:00.000Z");
    expect(n.durationS).toBe(3600);
    // 3600s / 10km = 360 s/km (6 min/km)
    expect(n.metrics.avg_pace_s_per_km).toBe(360);
    expect(n.metrics.distance_m).toBe(10_000);
    expect(n.metrics.avg_hr).toBe(152);
  });

  test("sets longRun=true when distance >= 16km and discipline=run", () => {
    const n = normalizeStravaActivity({
      ...baseActivity,
      distance: 18_500,
      moving_time: 7200,
    });
    expect(n.longRun).toBe(true);
  });

  test("does NOT mark longRun for a long ride", () => {
    const n = normalizeStravaActivity({
      ...baseActivity,
      sport_type: "Ride",
      distance: 50_000,
    });
    expect(n.discipline).toBe("ride");
    expect(n.longRun).toBe(false);
  });

  test("does NOT mark longRun for a short run", () => {
    const n = normalizeStravaActivity({ ...baseActivity, distance: 8_000 });
    expect(n.longRun).toBe(false);
  });

  test("avg_pace_s_per_km is null when distance is 0 (e.g. strength workout)", () => {
    const n = normalizeStravaActivity({
      ...baseActivity,
      sport_type: "WeightTraining",
      distance: 0,
    });
    expect(n.discipline).toBe("strength");
    expect(n.metrics.avg_pace_s_per_km).toBeNull();
  });

  test("handles missing optional metrics gracefully", () => {
    const n = normalizeStravaActivity({
      id: 1,
      sport_type: "Run",
      start_date: "2026-05-27T06:30:00Z",
      moving_time: 3000,
      distance: 5_000,
    });
    expect(n.metrics.avg_hr).toBeNull();
    expect(n.metrics.max_hr).toBeNull();
    expect(n.metrics.elev_gain_m).toBeNull();
    expect(n.metrics.calories).toBeNull();
  });

  test("sourceId is the activity id as a string", () => {
    const n = normalizeStravaActivity({ ...baseActivity, id: 42 });
    expect(n.sourceId).toBe("42");
    expect(typeof n.sourceId).toBe("string");
  });
});
