import { describe, expect, test } from "bun:test";
import { findSessionForOffset, isInLocalWindow } from "./scheduler.js";

// Back-compat shim for the existing morning-of tests (offset 0).
const findTodaysSession = (
  weeks: Parameters<typeof findSessionForOffset>[0],
  now: Date,
  tz: string,
  start: string,
) => findSessionForOffset(weeks, now, tz, start, 0);
import type { PlanSession } from "../plan/types.js";

describe("isInLocalWindow", () => {
  test("matches when local clock is exactly at the target time", () => {
    // 2026-06-08T06:00Z is 08:00 in Europe/Berlin (CEST = UTC+2)
    const now = new Date("2026-06-08T06:00:00Z");
    expect(isInLocalWindow(now, "Europe/Berlin", "08:00", 15)).toBe(true);
  });

  test("matches within the 15-minute window", () => {
    const now = new Date("2026-06-08T06:14:00Z"); // 08:14 Berlin
    expect(isInLocalWindow(now, "Europe/Berlin", "08:00", 15)).toBe(true);
  });

  test("does NOT match just past the window", () => {
    const now = new Date("2026-06-08T06:15:00Z"); // 08:15 Berlin
    expect(isInLocalWindow(now, "Europe/Berlin", "08:00", 15)).toBe(false);
  });

  test("does NOT match before the target", () => {
    const now = new Date("2026-06-08T05:59:00Z"); // 07:59 Berlin
    expect(isInLocalWindow(now, "Europe/Berlin", "08:00", 15)).toBe(false);
  });

  test("respects DST — northern hemisphere summer (CEST) vs winter (CET)", () => {
    // 2026-01-15T07:00Z = 08:00 Berlin in winter
    const winterNow = new Date("2026-01-15T07:00:00Z");
    expect(isInLocalWindow(winterNow, "Europe/Berlin", "08:00", 15)).toBe(true);
  });

  test("returns false on invalid time string", () => {
    const now = new Date("2026-06-08T06:00:00Z");
    expect(isInLocalWindow(now, "Europe/Berlin", "garbage", 15)).toBe(false);
  });
});

describe("findTodaysSession", () => {
  const weeks = [
    {
      index: 1,
      sessions: [
        { day_of_week: "monday", type: "rest", description: "Rest" },
        { day_of_week: "tuesday", type: "easy", distance_km: 5, description: "5K easy" },
        { day_of_week: "saturday", type: "long", distance_km: 14, description: "14K long" },
      ] as PlanSession[],
    },
    {
      index: 2,
      sessions: [
        { day_of_week: "monday", type: "rest", description: "Rest" },
        { day_of_week: "tuesday", type: "tempo", distance_km: 8, description: "Tempo 8K" },
      ] as PlanSession[],
    },
  ];

  test("returns the session for today's day of the right week", () => {
    // Plan starts Monday 2026-06-08. Tuesday 2026-06-09 = week 1, tuesday.
    const now = new Date("2026-06-09T04:00:00Z"); // 06:00 Berlin
    const s = findTodaysSession(weeks, now, "Europe/Berlin", "2026-06-08");
    expect(s?.type).toBe("easy");
  });

  test("returns week 2 session when 7 days past start", () => {
    // 2026-06-16 is Tuesday of week 2
    const now = new Date("2026-06-16T04:00:00Z");
    const s = findTodaysSession(weeks, now, "Europe/Berlin", "2026-06-08");
    expect(s?.type).toBe("tempo");
  });

  test("returns null when today is before plan start", () => {
    const now = new Date("2026-06-01T04:00:00Z");
    const s = findTodaysSession(weeks, now, "Europe/Berlin", "2026-06-08");
    expect(s).toBeNull();
  });

  test("returns null when today is past plan end", () => {
    const now = new Date("2026-08-01T04:00:00Z"); // way past
    const s = findTodaysSession(weeks, now, "Europe/Berlin", "2026-06-08");
    expect(s).toBeNull();
  });

  test("returns null when no session exists for today's day-of-week", () => {
    // Wednesday of week 1 has no session in fixture
    const now = new Date("2026-06-10T04:00:00Z");
    const s = findTodaysSession(weeks, now, "Europe/Berlin", "2026-06-08");
    expect(s).toBeNull();
  });

  test("F7: offset 1 (night-before) returns TOMORROW's session", () => {
    // Monday 2026-06-08 evening → offset 1 = Tuesday's easy run.
    const now = new Date("2026-06-08T19:00:00Z"); // 21:00 Berlin Monday
    const s = findSessionForOffset(weeks, now, "Europe/Berlin", "2026-06-08", 1);
    expect(s?.type).toBe("easy");
  });

  test("F7: offset 1 the night before a rest day returns the rest session", () => {
    // Sunday 2026-06-14 evening → offset 1 = Monday week 2 = rest.
    const now = new Date("2026-06-14T19:00:00Z");
    const s = findSessionForOffset(weeks, now, "Europe/Berlin", "2026-06-08", 1);
    expect(s?.type).toBe("rest");
  });
});
