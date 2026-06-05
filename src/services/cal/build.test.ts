import { describe, expect, test } from "bun:test";
import { buildGoogleQuickAddUrl, buildIcsForSession } from "./build.js";
import type { PlanSession } from "../plan/types.js";

const easy5K: PlanSession = {
  day_of_week: "tuesday",
  type: "easy",
  distance_km: 5,
  duration_min: 30,
  description: "5K easy at Z2",
  reasoning: "Base aerobic, 10%-rule build",
};

describe("buildIcsForSession", () => {
  test("emits a valid VCALENDAR with one VEVENT", () => {
    const ics = buildIcsForSession(easy5K, "2026-06-10", "06:00");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("PRODID:-//MARP//Training Plan//EN");
  });

  test("uses CRLF line endings (RFC 5545 spec)", () => {
    const ics = buildIcsForSession(easy5K, "2026-06-10", "06:00");
    // Spec: \r\n between lines. Ensure not bare \n.
    expect(ics).toContain("\r\n");
  });

  test("DTSTART matches session date + reminder time", () => {
    const ics = buildIcsForSession(easy5K, "2026-06-10", "06:00");
    expect(ics).toContain("DTSTART:20260610T060000");
  });

  test("DTEND = DTSTART + duration_min", () => {
    const ics = buildIcsForSession(easy5K, "2026-06-10", "06:00");
    // 06:00 + 30 min = 06:30
    expect(ics).toContain("DTEND:20260610T063000");
  });

  test("falls back to 60-min duration when session has no duration_min", () => {
    const { duration_min: _, ...noDuration } = easy5K;
    const ics = buildIcsForSession(noDuration as PlanSession, "2026-06-10", "06:00");
    expect(ics).toContain("DTEND:20260610T070000");
  });

  test("includes session reasoning in the description", () => {
    const ics = buildIcsForSession(easy5K, "2026-06-10", "06:00");
    expect(ics).toContain("Base aerobic");
  });

  test("escapes commas and semicolons in the description", () => {
    const session: PlanSession = {
      ...easy5K,
      description: "5K easy; HR < 145, conversation pace",
    };
    const ics = buildIcsForSession(session, "2026-06-10", "06:00");
    expect(ics).toContain("\\;");
    expect(ics).toContain("\\,");
  });
});

describe("buildGoogleQuickAddUrl", () => {
  test("uses the Google Calendar template URL", () => {
    const url = buildGoogleQuickAddUrl(easy5K, "2026-06-10", "06:00");
    expect(url).toStartWith("https://www.google.com/calendar/render?");
    expect(url).toContain("action=TEMPLATE");
  });

  test("encodes the session title in the text param", () => {
    const url = buildGoogleQuickAddUrl(easy5K, "2026-06-10", "06:00");
    // URLSearchParams encodes ":" as "%3A"
    expect(url).toMatch(/text=Easy%3A\+5km(\+)?(%2F)?30min|text=Easy(%3A|:)/);
  });

  test("dates param encodes start/end in floating local format", () => {
    const url = buildGoogleQuickAddUrl(easy5K, "2026-06-10", "06:00");
    // URLSearchParams encodes "/" as "%2F"
    expect(url).toContain("dates=20260610T060000%2F20260610T063000");
  });
});
