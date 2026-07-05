import { describe, expect, it } from "bun:test";
import { buildPlanFeed, foldIcsLine, resolveSessionTime } from "./export.js";
import { generatePlanFeedToken, verifyPlanFeedToken } from "./token.js";
import type { Plan } from "../plan/types.js";

const PLAN: Plan = {
  source: "generated",
  start_date: "2026-07-06", // a Monday
  weeks: [
    {
      index: 1,
      phase: "base",
      total_km: 30,
      focus: "consistency first",
      sessions: [
        {
          day_of_week: "tuesday",
          type: "easy",
          distance_km: 8,
          description: "Easy 8K @ 5:40/km, Z2, RPE 3–4 — hold a full sentence",
          reasoning: "Z2 base; primary aerobic stimulus",
        },
        {
          day_of_week: "thursday",
          type: "tempo",
          distance_km: 8,
          duration_min: 45,
          // Long description + emoji + a smuggled \r — the folding/escaping case.
          description:
            "Tempo 8K: 2K warmup, 4K @ 4:55/km (RPE 6–7) 🔥, 2K cooldown.\r Keep the effort honest — comfortably hard, not race pace, and check the knee after.",
          reasoning: "Lactate threshold development (Daniels T-pace)",
        },
        { day_of_week: "sunday", type: "long", distance_km: 14, description: "Long 14K, conversational", reasoning: "Aerobic endurance" },
        { day_of_week: "monday", type: "rest", description: "Rest" },
      ],
    },
  ],
} as Plan;

describe("buildPlanFeed", () => {
  const feed = buildPlanFeed(
    PLAN,
    { preferredTime: "evening", reminderPrefs: null },
    { now: new Date("2026-07-05T10:00:00Z") },
  );

  it("emits one VEVENT per non-rest session (rest days excluded)", () => {
    expect(feed.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(feed).not.toContain("Rest");
  });

  it("computes session dates from start_date + week/day offsets", () => {
    expect(feed).toContain("DTSTART:20260707T180000"); // Tue wk1, evening=18:00
    expect(feed).toContain("DTSTART:20260712T180000"); // Sun wk1
  });

  it("descriptions coach: what, why, and the week's place in the arc", () => {
    const unfolded = feed.replace(/\r\n /g, "");
    expect(unfolded).toContain("Why: Z2 base");
    expect(unfolded).toContain("Week 1 (base) — consistency first");
  });

  it("strips smuggled CR characters (no raw \\r injection)", () => {
    // The tempo description contained a literal \r — it must not survive.
    const unfolded = feed.replace(/\r\n /g, "");
    expect(unfolded).not.toMatch(/\r(?!\n)/);
  });

  it("folds every line to <=75 octets (strict-parser compatibility)", () => {
    for (const line of feed.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(76); // 75 + leading space on continuations
    }
  });

  it("pins the UID convention (date-type@marp-plan; collision documented)", () => {
    expect(feed).toContain("UID:2026-07-07-easy@marp-plan");
  });

  it("empty plan renders a valid empty calendar", () => {
    const empty = buildPlanFeed(
      { ...PLAN, weeks: [] },
      { preferredTime: null },
      { now: new Date("2026-07-05T10:00:00Z") },
    );
    expect(empty).toContain("BEGIN:VCALENDAR");
    expect(empty).toContain("END:VCALENDAR");
    expect(empty).not.toContain("VEVENT");
  });
});

describe("resolveSessionTime — workout time, never reminder time", () => {
  it("maps preferred_time", () => {
    expect(resolveSessionTime({ preferredTime: "morning" })).toBe("07:00");
    expect(resolveSessionTime({ preferredTime: "lunch" })).toBe("12:00");
    expect(resolveSessionTime({ preferredTime: "evening" })).toBe("18:00");
    expect(resolveSessionTime({ preferredTime: null })).toBe("07:00");
  });

  it("uses reminder time ONLY for morning_of (night_before is a reminder, not a workout)", () => {
    expect(
      resolveSessionTime({
        reminderPrefs: { time_local: "06:30", timing: "morning_of" },
      }),
    ).toBe("06:30");
    // The routes/cal.ts bug this module fixes: 21:00 night-before must NOT
    // become the workout slot.
    expect(
      resolveSessionTime({
        preferredTime: "morning",
        reminderPrefs: { time_local: "21:00", timing: "night_before" },
      }),
    ).toBe("07:00");
  });
});

describe("foldIcsLine", () => {
  it("leaves short lines alone", () => {
    expect(foldIcsLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("folds long lines at 75 octets with CRLF+space continuations", () => {
    const folded = foldIcsLine(`DESCRIPTION:${"x".repeat(200)}`);
    const parts = folded.split("\r\n ");
    expect(parts.length).toBeGreaterThan(1);
    expect(Buffer.byteLength(parts[0]!, "utf8")).toBeLessThanOrEqual(75);
  });

  it("never splits inside a multi-byte emoji", () => {
    const folded = foldIcsLine(`SUMMARY:${"🔥".repeat(40)}`);
    // Re-joining must reproduce the original content losslessly.
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"🔥".repeat(40)}`);
  });
});

describe("plan feed token", () => {
  it("round-trips athlete + version", () => {
    const t = generatePlanFeedToken("athlete-123", 3);
    const v = verifyPlanFeedToken(t);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.athleteId).toBe("athlete-123");
      expect(v.payload.feedVersion).toBe(3);
    }
  });

  it("rejects tampering and session-scope tokens", () => {
    const t = generatePlanFeedToken("athlete-123", 1);
    const tampered = `${t.slice(0, -3)}abc`;
    expect(verifyPlanFeedToken(tampered).ok).toBe(false);
    expect(verifyPlanFeedToken("garbage").ok).toBe(false);
  });
});
