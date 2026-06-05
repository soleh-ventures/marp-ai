// V10 — fixture profiles for the plan-generator eval suite.
//
// Each fixture is a self-contained runner profile that the eval feeds
// into the plan generator (as the memory-context string the runner
// would normally have built up by the time they ask for a plan). The
// constraints object lists what the resulting plan MUST satisfy — the
// validators read it to grade.
//
// Five fixtures cover the failure modes most likely to surface:
//   1. First-marathon, low base → ramp discipline + taper
//   2. Sub-3 chaser, high base → quality balance, doesn't sandbag
//   3. Time-crunched 4 days/week → respects days-per-week cap
//   4. Injury-flagged → reduced intensity, cross-train emphasis
//   5. No race date → handles missing race gracefully (base block)

export type PlanFixture = {
  name: string;
  // The memoryText the generator would receive as input — pre-formatted
  // the same way getMemoryContext() formats real athlete data, so we
  // hit the same code path as production.
  memoryText: string;
  constraints: {
    // Hard limits the plan MUST respect for the fixture to pass.
    maxDaysPerWeek?: number;
    maxLongRunKm?: number;
    // Phrases that MUST appear at least once in the plan's reasoning
    // text (e.g. "cross" for an injured runner).
    mustInclude?: string[];
    // Phrases that MUST NOT appear (e.g. high-intensity work for
    // an injured runner).
    mustNotInclude?: string[];
    // Lower bound on number of weeks (no abridged plans).
    minWeeks?: number;
    // If true, the plan must NOT include a "race" session (no race date).
    noRaceSession?: boolean;
  };
};

export const FIXTURES: PlanFixture[] = [
  {
    name: "first-marathon-low-base",
    memoryText: [
      "## Athlete profile",
      "Name: Sarah",
      "Age: 34",
      "Locale: London, UK",
      "Goal: First marathon — London Marathon, ~12 weeks out",
      "Race date: 2026-08-27 (12 weeks from today)",
      "",
      "## Current fitness",
      "Recent weekly volume: 25km/week",
      "Longest recent run: 14km",
      "Has been running consistently 3-4 days/week for 6 months.",
      "5K PR: 26:00",
      "",
      "## Constraints",
      "Trains 4-5 days/week. Available days: any.",
      "Long run preference: Sunday.",
      "",
      "## Active flags",
      "None.",
    ].join("\n"),
    constraints: {
      maxLongRunKm: 32,
      minWeeks: 10,
    },
  },
  {
    name: "sub-3-chaser-high-base",
    memoryText: [
      "## Athlete profile",
      "Name: Marcus",
      "Age: 38",
      "Locale: Berlin, Germany",
      "Goal: Sub-3:00 marathon — Berlin Marathon, 16 weeks out",
      "Race date: 2026-09-26",
      "",
      "## Current fitness",
      "Recent weekly volume: 80km/week",
      "Longest recent run: 28km",
      "10K PR: 35:40, half-marathon PR: 1:18:30",
      "Marathon PR: 3:08 (Berlin 2025)",
      "Training age: 8 years, 4 marathons completed.",
      "",
      "## Constraints",
      "Trains 6 days/week. Long run Sunday.",
      "",
      "## Active flags",
      "None.",
    ].join("\n"),
    constraints: {
      maxLongRunKm: 36,
      minWeeks: 14,
    },
  },
  {
    name: "time-crunched-4-days",
    memoryText: [
      "## Athlete profile",
      "Name: Priya",
      "Age: 41",
      "Locale: Singapore",
      "Goal: Half-marathon sub-1:45 — Singapore Half, 10 weeks out",
      "Race date: 2026-08-13",
      "",
      "## Current fitness",
      "Recent weekly volume: 35km/week",
      "Longest recent run: 16km",
      "Half-marathon PR: 1:52 (2024).",
      "",
      "## Constraints",
      "ONLY 4 days/week available — Mon/Wed/Fri/Sat are the only feasible days.",
      "Long run Saturday.",
      "",
      "## Active flags",
      "None.",
    ].join("\n"),
    constraints: {
      maxDaysPerWeek: 4,
      maxLongRunKm: 22,
      minWeeks: 8,
    },
  },
  {
    name: "injury-flagged-knee",
    memoryText: [
      "## Athlete profile",
      "Name: David",
      "Age: 45",
      "Locale: Manchester, UK",
      "Goal: Marathon completion — Manchester Marathon, 14 weeks out",
      "Race date: 2026-09-09",
      "",
      "## Current fitness",
      "Recent weekly volume: 30km/week (was 50 before injury)",
      "Longest recent run: 12km (cut back this month)",
      "",
      "## Active flags",
      "INJURY: Mild right-knee niggle, started 2 weeks ago. Pain at 4/10 on long runs. Has NOT seen physio yet. Cross-training (cycling) tolerated well.",
      "",
      "## Constraints",
      "Trains 5 days/week. Long run Sunday.",
      "Open to cross-training as substitute for running days.",
    ].join("\n"),
    constraints: {
      maxLongRunKm: 32,
      mustInclude: ["cross"],
      minWeeks: 12,
    },
  },
  {
    name: "no-race-date-base-block",
    memoryText: [
      "## Athlete profile",
      "Name: Ana",
      "Age: 29",
      "Locale: Madrid, Spain",
      "Goal: General fitness + build aerobic base for future racing. NO race date set.",
      "",
      "## Current fitness",
      "Recent weekly volume: 20km/week",
      "Longest recent run: 10km",
      "Comeback after 6-month layoff.",
      "",
      "## Constraints",
      "Trains 4 days/week. Long run Saturday.",
      "",
      "## Active flags",
      "None.",
    ].join("\n"),
    constraints: {
      minWeeks: 8,
      noRaceSession: true,
    },
  },
];
