import { describe, expect, test } from "bun:test";
import {
  computeWeekAdherence,
  currentWeekIndex,
  renderAdherenceLine,
  type AdherenceActivity,
} from "./adherence.js";
import type { Plan, PlanSession } from "./types.js";

// start_date is a Monday; week 1 = Jun 1–7, week 2 = Jun 8–14.
function plan(sessions: PlanSession[], weeks = 1): Plan {
  const w = Array.from({ length: weeks }, (_, i) => ({
    index: i + 1,
    sessions: i === 0 ? sessions : [],
  }));
  return {
    version: 1,
    source: "generated",
    start_date: "2026-06-01",
    weeks: w,
    generated_at: "2026-06-01T00:00:00Z",
  };
}

function run(dateISO: string, km: number, durationMin = 40, discipline = "run"): AdherenceActivity {
  return {
    discipline,
    startedAt: new Date(`${dateISO}T08:00:00Z`),
    durationS: durationMin * 60,
    metrics: { distance_m: km * 1000 },
  };
}

const easyMon: PlanSession = { day_of_week: "monday", type: "easy", distance_km: 8, description: "Easy 8k" };
const tempoWed: PlanSession = { day_of_week: "wednesday", type: "tempo", duration_min: 40, description: "Tempo 40min" };
const longSat: PlanSession = { day_of_week: "saturday", type: "long", distance_km: 10, description: "Long 10k" };
const restSun: PlanSession = { day_of_week: "sunday", type: "rest", description: "Rest" };

describe("currentWeekIndex (computed from start_date)", () => {
  const p = plan([], 4);
  test("today inside week 2", () => expect(currentWeekIndex(p, "2026-06-10")).toBe(2));
  test("today on week-1 monday", () => expect(currentWeekIndex(p, "2026-06-01")).toBe(1));
  test("before the plan starts → week 1", () => expect(currentWeekIndex(p, "2026-05-20")).toBe(1));
  test("past the last week → last week", () => expect(currentWeekIndex(p, "2026-08-01")).toBe(4));
});

describe("computeWeekAdherence", () => {
  const sessions = [easyMon, tempoWed, longSat, restSun];

  test("short long run is flagged SHORT, not done (bug #3)", () => {
    const acts = [
      run("2026-06-01", 8), // monday easy 8k → done
      run("2026-06-06", 5), // saturday: ran 5k of prescribed 10k → SHORT
    ];
    // Wednesday tempo missed; today = end of week so all days are past.
    const wa = computeWeekAdherence(plan(sessions), 1, acts, "2026-06-07");
    const byDay = Object.fromEntries(wa.sessions.map((s) => [s.prescribed.type, s.status]));
    expect(byDay.easy).toBe("done");
    expect(byDay.long).toBe("short");
    expect(byDay.tempo).toBe("missed");
    // rest days are not adherence sessions
    expect(wa.sessions.some((s) => s.prescribed.type === "rest")).toBe(false);
  });

  test("future prescribed days are upcoming, not missed (mid-week)", () => {
    const wa = computeWeekAdherence(plan(sessions), 1, [run("2026-06-01", 8)], "2026-06-03");
    const long = wa.sessions.find((s) => s.prescribed.type === "long");
    expect(long?.status).toBe("upcoming"); // saturday is still ahead
  });

  test("wrong discipline is flagged", () => {
    const acts = [run("2026-06-01", 30, 60, "cross")]; // monday: did a cross/ride, not a run
    const wa = computeWeekAdherence(plan(sessions), 1, acts, "2026-06-07");
    expect(wa.sessions.find((s) => s.prescribed.type === "easy")?.status).toBe("wrong_discipline");
  });

  test("well-over distance is flagged OVER", () => {
    const acts = [run("2026-06-06", 14)]; // saturday: 14k vs prescribed 10k
    const wa = computeWeekAdherence(plan(sessions), 1, acts, "2026-06-07");
    expect(wa.sessions.find((s) => s.prescribed.type === "long")?.status).toBe("over");
  });

  test("unplanned activities surface as extras", () => {
    const acts = [run("2026-06-04", 6)]; // thursday — nothing prescribed
    const wa = computeWeekAdherence(plan(sessions), 1, acts, "2026-06-07");
    expect(wa.extras).toHaveLength(1);
    expect(wa.extras[0]?.date).toBe("2026-06-04");
    expect(wa.extras[0]?.km).toBe(6);
  });

  test("one activity can't satisfy two sessions (no double-count)", () => {
    // Two prescribed runs same day; one actual run → one done, one missed.
    const twoSameDay: PlanSession[] = [
      { day_of_week: "monday", type: "easy", distance_km: 5, description: "AM easy" },
      { day_of_week: "monday", type: "intervals", distance_km: 8, description: "PM intervals" },
    ];
    const wa = computeWeekAdherence(plan(twoSameDay), 1, [run("2026-06-01", 5)], "2026-06-07");
    const statuses = wa.sessions.map((s) => s.status).sort();
    expect(statuses).toEqual(["done", "missed"]);
  });
});

describe("renderAdherenceLine", () => {
  test("names the short session as a ground-truth fact", () => {
    const wa = computeWeekAdherence(
      plan([easyMon, longSat]),
      1,
      [run("2026-06-01", 8), run("2026-06-06", 5)],
      "2026-06-07",
    );
    const line = renderAdherenceLine(wa);
    expect(line).toContain("ran 5km of a prescribed 10km");
    expect(line).toMatch(/SHORT/);
    expect(line).toMatch(/do not call a short or missed session complete/i);
  });

  test("returns null when nothing is due yet", () => {
    const wa = computeWeekAdherence(plan([longSat]), 1, [], "2026-06-01");
    expect(renderAdherenceLine(wa)).toBeNull(); // saturday still upcoming, no extras
  });
});
