// M1 (T8) — eval fixtures for the three new coaching-loop prompts.
//
// Mirrors the plan-generator eval (src/services/plan/eval): fixtures here +
// pure validators in m1-validators.ts + the live runner in
// src/scripts/eval-m1.ts. Retro gets the deepest set — it's the prompt that
// mutates real plans.

// ── post-run-analysis ──────────────────────────────────────────────────────
export type AnalysisFixture = {
  name: string;
  objective: Record<string, unknown>;
  longRun?: boolean;
  plannedType?: string;
  // The read should surface at least one of these (case-insensitive) given the
  // objective pattern. Empty = no grounded-mention requirement.
  expectMentions: string[];
};

export const ANALYSIS_FIXTURES: AnalysisFixture[] = [
  {
    name: "even-z2-easy",
    objective: { source: "splits", distance_km: 8, avg_pace_s_per_km: 330, avg_hr: 140, split_pattern: "even", pace_drift_pct: 0.5, hr_drift_pct: 1 },
    plannedType: "easy",
    expectMentions: ["even", "easy", "z2", "zone 2", "controlled", "aerobic"],
  },
  {
    name: "positive-split-fade",
    objective: { source: "splits", distance_km: 10, avg_pace_s_per_km: 300, avg_hr: 168, split_pattern: "positive", pace_drift_pct: 7, hr_drift_pct: 9 },
    plannedType: "tempo",
    expectMentions: ["fade", "faded", "positive", "drift", "slowed", "hot", "second half"],
  },
  {
    name: "no-splits-summary",
    objective: { source: "summary", distance_km: 6, avg_pace_s_per_km: 360, avg_hr: null, per_km: null },
    plannedType: "easy",
    expectMentions: [],
  },
];

// ── feeling-extract ──────────────────────────────────────────────────────
export type FeelingFixture = {
  name: string;
  objectiveJson?: string;
  message: string;
  expect: {
    captured: boolean;
    rpe?: number | null;
    band?: string;
    pain?: boolean;
    adherence?: string;
  };
};

export const FEELING_FIXTURES: FeelingFixture[] = [
  { name: "hard-cut-short", message: "legs were dead, maybe a 7, cut it 2k short", expect: { captured: true, rpe: 7, adherence: "cut_short" } },
  { name: "easy-great", message: "felt great out there, smooth and easy the whole way", expect: { captured: true, band: "easy" } },
  { name: "pain", message: "knee started niggling around the 5k mark", expect: { captured: true, pain: true } },
  { name: "not-a-feeling", message: "what's on the plan for tomorrow?", expect: { captured: false } },
];

// ── retro-proposal (deepest set) ───────────────────────────────────────────
export type RetroFixture = {
  name: string;
  planContext: string; // pre-rendered "Current plan" block
  signalsJson: string;
  reads: string;
  flags: string;
  trigger: "weekly_sweep" | "event";
  expect: {
    adjust: boolean;
    // When true, an accepted change must NOT increase load (fatigue/injury).
    noLoadIncrease?: boolean;
  };
};

const SAMPLE_PLAN_CTX = `Training plan (12 weeks). Method: Pfitz base→build→peak→taper.
  Week 2 [2026-06-08–2026-06-14] build, 52km:
    Mon: rest — Rest
    Tue: intervals — 5x3min @ 5K pace, RPE 8-9
    Thu: tempo — Tempo 8K @ threshold, RPE 6-7
    Sun: long — Long 22K, RPE 5`;

export const RETRO_FIXTURES: RetroFixture[] = [
  {
    name: "stable-week-no-change",
    planContext: SAMPLE_PLAN_CTX,
    signalsJson: JSON.stringify({ runs: 4, hard_efforts: 1, avg_rpe: 5, low_energy: 0, cut_or_skipped: 0, positive_splits: 0, rising_hr_drift: 0, pain: false }),
    reads: "- Even splits, controlled HR | feeling: rpe 5, positive\n- Solid tempo | feeling: rpe 7, neutral",
    flags: "none",
    trigger: "weekly_sweep",
    expect: { adjust: false },
  },
  {
    name: "fatigue-overreach",
    planContext: SAMPLE_PLAN_CTX,
    signalsJson: JSON.stringify({ runs: 4, hard_efforts: 3, avg_rpe: 8, low_energy: 3, cut_or_skipped: 0, positive_splits: 2, rising_hr_drift: 3, pain: false }),
    reads: "- Faded second half, HR climbing | feeling: rpe 9, depleted\n- Hard, legs flat | feeling: rpe 8, depleted",
    flags: "none",
    trigger: "weekly_sweep",
    expect: { adjust: true, noLoadIncrease: true },
  },
  {
    name: "open-injury-flag",
    planContext: SAMPLE_PLAN_CTX,
    signalsJson: JSON.stringify({ runs: 3, hard_efforts: 1, avg_rpe: 6, low_energy: 1, cut_or_skipped: 1, positive_splits: 0, rising_hr_drift: 0, pain: true }),
    reads: "- Cut short, knee twinge | feeling: rpe 6, PAIN",
    flags: "injury: left knee niggle, started 2 days ago",
    trigger: "event",
    expect: { adjust: true, noLoadIncrease: true },
  },
  {
    name: "cutting-sessions-short",
    planContext: SAMPLE_PLAN_CTX,
    signalsJson: JSON.stringify({ runs: 4, hard_efforts: 1, avg_rpe: 6, low_energy: 1, cut_or_skipped: 3, positive_splits: 0, rising_hr_drift: 0, pain: false }),
    reads: "- Cut it short, busy week | feeling: rpe 6, cut_short\n- Skipped the long run | feeling: cut_short",
    flags: "none",
    trigger: "weekly_sweep",
    expect: { adjust: true, noLoadIncrease: true },
  },
  {
    name: "under-target-ready-to-progress",
    planContext: SAMPLE_PLAN_CTX,
    signalsJson: JSON.stringify({ runs: 5, hard_efforts: 0, avg_rpe: 3, low_energy: 0, cut_or_skipped: 0, positive_splits: 0, rising_hr_drift: 0, pain: false }),
    reads: "- Comfortable, barely breathing hard | feeling: rpe 3, positive\n- Easy and smooth | feeling: rpe 3, positive",
    flags: "none",
    trigger: "weekly_sweep",
    expect: { adjust: true, noLoadIncrease: false },
  },
  {
    name: "single-mild-signal-leave-alone",
    planContext: SAMPLE_PLAN_CTX,
    signalsJson: JSON.stringify({ runs: 4, hard_efforts: 1, avg_rpe: 5, low_energy: 1, cut_or_skipped: 0, positive_splits: 1, rising_hr_drift: 0, pain: false }),
    reads: "- One harder day, otherwise steady | feeling: rpe 5, neutral",
    flags: "none",
    trigger: "weekly_sweep",
    expect: { adjust: false },
  },
];
