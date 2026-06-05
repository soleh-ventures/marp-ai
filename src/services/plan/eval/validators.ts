// V10 — rule-based validators for the plan-generator eval.
//
// Five checks per plan. A plan passes if ≥4/5 checks pass (the eval
// orchestration applies the threshold; this module just returns a
// per-check verdict). Validators are deterministic — given a fixed
// Plan + fixture, the verdict never changes.
//
// Recognised-principle whitelist exists because the #1 regression we
// want to catch is "the LLM invented a coaching framework" (e.g. "the
// Roosevelt periodisation method"). If every reasoning string maps to
// at least one whitelist phrase, we have evidence the LLM is staying
// inside known-good vocabulary.

import type { Plan, PlanSession } from "../types.js";
import type { PlanFixture } from "./fixtures.js";

export type CheckId =
  | "structure"
  | "taper"
  | "reasoning_principles"
  | "rest_days"
  | "constraints";

export type CheckResult = {
  id: CheckId;
  pass: boolean;
  detail: string;
};

export type FixtureResult = {
  fixture: string;
  checks: CheckResult[];
  pass: boolean; // true if ≥4 checks pass
};

// Lowercased — match is substring + case-insensitive on the reasoning
// field. Curated from the plan-generator prompt's allow-list (Rule 6).
const PRINCIPLE_PHRASES = [
  "10%-rule",
  "10% rule",
  "ten percent",
  "pfitz",
  "lactate threshold",
  "lactate",
  "vo2max",
  "vo2 max",
  "z2",
  "zone 2",
  "aerobic base",
  "aerobic",
  "glycogen",
  "polarised",
  "polarized",
  "80/20",
  "jack daniels",
  "vdot",
  "taper",
  "deload",
  "cutback",
  "race pace",
  "marathon pace",
  "threshold",
  "tempo",
  "base mileage",
  "base building",
  "specific endurance",
  "stride",
  "neuromuscular",
  "fatigue resistance",
];

export function runChecks(plan: Plan, fixture: PlanFixture): FixtureResult {
  const checks: CheckResult[] = [
    checkStructure(plan, fixture),
    checkTaper(plan, fixture),
    checkReasoningPrinciples(plan),
    checkRestDays(plan),
    checkConstraints(plan, fixture),
  ];
  const passing = checks.filter((c) => c.pass).length;
  return {
    fixture: fixture.name,
    checks,
    pass: passing >= 4,
  };
}

// CHECK 1 — structure: plan must have ≥ minWeeks of sessions and every
// week must have ≥1 session.
function checkStructure(plan: Plan, fixture: PlanFixture): CheckResult {
  const min = fixture.constraints.minWeeks ?? 1;
  if (plan.weeks.length < min) {
    return {
      id: "structure",
      pass: false,
      detail: `expected ≥${min} weeks, got ${plan.weeks.length}`,
    };
  }
  const emptyWeek = plan.weeks.find((w) => w.sessions.length === 0);
  if (emptyWeek) {
    return {
      id: "structure",
      pass: false,
      detail: `week ${emptyWeek.index} has no sessions`,
    };
  }
  return {
    id: "structure",
    pass: true,
    detail: `${plan.weeks.length} weeks, all populated`,
  };
}

// CHECK 2 — taper: either at least one week has phase="taper", OR the
// final 2-3 weeks show decreasing total_km. Plans without taper are a
// known LLM failure mode and an injury risk.
function checkTaper(plan: Plan, fixture: PlanFixture): CheckResult {
  // No-race fixtures don't need a taper.
  if (fixture.constraints.noRaceSession) {
    return { id: "taper", pass: true, detail: "taper not required (no race)" };
  }
  const hasTaperPhase = plan.weeks.some((w) => w.phase === "taper");
  if (hasTaperPhase) {
    return { id: "taper", pass: true, detail: "taper phase present" };
  }
  // Fallback: check the last 2 weeks for declining volume.
  if (plan.weeks.length >= 3) {
    const last = plan.weeks[plan.weeks.length - 1];
    const secondLast = plan.weeks[plan.weeks.length - 2];
    const thirdLast = plan.weeks[plan.weeks.length - 3];
    const lastKm = last?.total_km;
    const secondLastKm = secondLast?.total_km;
    const thirdLastKm = thirdLast?.total_km;
    if (
      typeof lastKm === "number" &&
      typeof secondLastKm === "number" &&
      typeof thirdLastKm === "number" &&
      lastKm < secondLastKm &&
      secondLastKm < thirdLastKm
    ) {
      return {
        id: "taper",
        pass: true,
        detail: `volume tapers ${thirdLastKm}→${secondLastKm}→${lastKm}km`,
      };
    }
  }
  return {
    id: "taper",
    pass: false,
    detail: "no taper phase and volume not declining in final weeks",
  };
}

// CHECK 3 — reasoning cites recognised principles. Every non-rest
// session SHOULD have reasoning, and ≥80% of those should include at
// least one whitelist phrase. The threshold is per-plan, not
// per-session — a single weak-reasoning session shouldn't fail the
// fixture, but a pattern of hallucinated frameworks should.
function checkReasoningPrinciples(plan: Plan): CheckResult {
  const sessions = plan.weeks
    .flatMap((w) => w.sessions)
    .filter((s) => s.type !== "rest");
  if (sessions.length === 0) {
    return {
      id: "reasoning_principles",
      pass: false,
      detail: "no non-rest sessions to evaluate",
    };
  }
  const withReasoning = sessions.filter(
    (s) => s.reasoning && s.reasoning.trim().length > 0,
  );
  const coverageRatio = withReasoning.length / sessions.length;
  if (coverageRatio < 0.8) {
    return {
      id: "reasoning_principles",
      pass: false,
      detail: `only ${withReasoning.length}/${sessions.length} sessions have reasoning (<80%)`,
    };
  }
  const matchesPrinciple = (s: PlanSession): boolean => {
    const text = (s.reasoning ?? "").toLowerCase();
    return PRINCIPLE_PHRASES.some((p) => text.includes(p));
  };
  const principled = withReasoning.filter(matchesPrinciple);
  const principleRatio = principled.length / withReasoning.length;
  if (principleRatio < 0.8) {
    const sample = withReasoning
      .filter((s) => !matchesPrinciple(s))
      .slice(0, 2)
      .map((s) => `"${s.reasoning}"`)
      .join(", ");
    return {
      id: "reasoning_principles",
      pass: false,
      detail: `${principled.length}/${withReasoning.length} sessions cite a known principle (<80%); examples missing: ${sample}`,
    };
  }
  return {
    id: "reasoning_principles",
    pass: true,
    detail: `${principled.length}/${withReasoning.length} sessions cite a recognised principle`,
  };
}

// CHECK 4 — rest days. Every week must have ≥1 rest day. (Base weeks
// SHOULD have ≥2 but we don't enforce that strictly — the prompt asks
// for it, and the soft signal is enough for v1.1.)
function checkRestDays(plan: Plan): CheckResult {
  const offenders = plan.weeks.filter(
    (w) => w.sessions.filter((s) => s.type === "rest").length < 1,
  );
  if (offenders.length > 0) {
    return {
      id: "rest_days",
      pass: false,
      detail: `weeks without rest: ${offenders.map((w) => w.index).join(", ")}`,
    };
  }
  return {
    id: "rest_days",
    pass: true,
    detail: "every week has ≥1 rest day",
  };
}

// CHECK 5 — fixture-specific constraints. maxDaysPerWeek (non-rest
// sessions ≤ cap), maxLongRunKm (no long session over cap), mustInclude
// (≥1 reasoning mentions phrase), mustNotInclude (no reasoning mentions
// phrase), noRaceSession (no session has type="race").
function checkConstraints(plan: Plan, fixture: PlanFixture): CheckResult {
  const { constraints } = fixture;
  const failures: string[] = [];

  if (typeof constraints.maxDaysPerWeek === "number") {
    const cap = constraints.maxDaysPerWeek;
    const overWeeks = plan.weeks.filter((w) => {
      const trainingDays = w.sessions.filter(
        (s) => s.type !== "rest" && s.type !== "cross",
      ).length;
      return trainingDays > cap;
    });
    if (overWeeks.length > 0) {
      failures.push(
        `week(s) ${overWeeks.map((w) => w.index).join(", ")} exceed ${cap} training days`,
      );
    }
  }

  if (typeof constraints.maxLongRunKm === "number") {
    const cap = constraints.maxLongRunKm;
    const longSessions = plan.weeks
      .flatMap((w) => w.sessions)
      .filter((s) => s.type === "long" && typeof s.distance_km === "number");
    const over = longSessions.find((s) => (s.distance_km ?? 0) > cap);
    if (over) {
      failures.push(`long run ${over.distance_km}km exceeds ${cap}km cap`);
    }
  }

  if (constraints.mustInclude) {
    const allText = plan.weeks
      .flatMap((w) => w.sessions)
      .map((s) => `${s.description} ${s.reasoning ?? ""}`)
      .join(" ")
      .toLowerCase();
    const allTypes = new Set(
      plan.weeks.flatMap((w) => w.sessions).map((s) => s.type),
    );
    for (const phrase of constraints.mustInclude) {
      const lower = phrase.toLowerCase();
      const inText = allText.includes(lower);
      // "cross" also matches the cross session type.
      const inTypes = lower === "cross" && allTypes.has("cross");
      if (!inText && !inTypes) {
        failures.push(`missing required phrase: "${phrase}"`);
      }
    }
  }

  if (constraints.mustNotInclude) {
    const allText = plan.weeks
      .flatMap((w) => w.sessions)
      .map((s) => `${s.description} ${s.reasoning ?? ""}`)
      .join(" ")
      .toLowerCase();
    for (const phrase of constraints.mustNotInclude) {
      if (allText.includes(phrase.toLowerCase())) {
        failures.push(`contains forbidden phrase: "${phrase}"`);
      }
    }
  }

  if (constraints.noRaceSession) {
    const hasRace = plan.weeks
      .flatMap((w) => w.sessions)
      .some((s) => s.type === "race");
    if (hasRace) {
      failures.push("plan contains a race session but fixture has no race");
    }
  }

  if (failures.length === 0) {
    return {
      id: "constraints",
      pass: true,
      detail: "all fixture constraints respected",
    };
  }
  return {
    id: "constraints",
    pass: false,
    detail: failures.join("; "),
  };
}
