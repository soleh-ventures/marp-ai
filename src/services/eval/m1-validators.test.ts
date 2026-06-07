import { describe, expect, test } from "bun:test";
import { checkAnalysis, checkFeeling, checkRetro } from "./m1-validators.js";
import type { AnalysisFixture, FeelingFixture, RetroFixture } from "./m1-fixtures.js";

// These grade pre-canned LLM outputs — no live model. They verify the
// validators themselves (the gradeable core); the live run is eval:m1.

describe("checkAnalysis", () => {
  const fx: AnalysisFixture = {
    name: "even",
    objective: { split_pattern: "even" },
    plannedType: "easy",
    expectMentions: ["even", "z2"],
  };
  test("a grounded statement passes", () => {
    const v = checkAnalysis("Even splits with HR steady in Z2 — clean aerobic work.", fx);
    expect(v.pass).toBe(true);
  });
  test("a question fails not_a_question", () => {
    const v = checkAnalysis("Even splits — how did it feel?", fx);
    expect(v.pass).toBe(false);
    expect(v.checks.find((c) => c.id === "not_a_question")!.pass).toBe(false);
  });
  test("missing the expected concept fails grounded_mention", () => {
    const v = checkAnalysis("A run happened and it was a run.", fx);
    expect(v.checks.find((c) => c.id === "grounded_mention")!.pass).toBe(false);
  });
  test("empty output fails non_empty", () => {
    expect(checkAnalysis("   ", fx).checks.find((c) => c.id === "non_empty")!.pass).toBe(false);
  });
});

describe("checkFeeling", () => {
  function out(feeling: unknown): string {
    return JSON.stringify({ feeling });
  }
  test("captured + fields match", () => {
    const fx: FeelingFixture = { name: "hard", message: "dead, 7, cut short", expect: { captured: true, rpe: 7, adherence: "cut_short" } };
    const v = checkFeeling(
      out({ effort: { rpe: 7, band: "hard" }, energy: "depleted", pain: { present: false }, adherence: "cut_short" }),
      fx,
    );
    expect(v.pass).toBe(true);
  });
  test("wrong rpe fails", () => {
    const fx: FeelingFixture = { name: "hard", message: "x", expect: { captured: true, rpe: 7 } };
    const v = checkFeeling(out({ effort: { rpe: 3, band: "easy" }, pain: { present: false }, adherence: "as_planned" }), fx);
    expect(v.pass).toBe(false);
  });
  test("expected-null but model captured → fail", () => {
    const fx: FeelingFixture = { name: "nope", message: "what's tomorrow?", expect: { captured: false } };
    const v = checkFeeling(out({ effort: { rpe: 5, band: "moderate" }, pain: { present: false }, adherence: "unknown" }), fx);
    expect(v.checks[0]!.pass).toBe(false);
  });
  test("expected-null and model returned null → pass", () => {
    const fx: FeelingFixture = { name: "nope", message: "what's tomorrow?", expect: { captured: false } };
    expect(checkFeeling('{"feeling": null}', fx).pass).toBe(true);
  });
});

describe("checkRetro", () => {
  const base: Omit<RetroFixture, "expect"> = {
    name: "x",
    planContext: "plan",
    signalsJson: "{}",
    reads: "",
    flags: "none",
    trigger: "weekly_sweep",
  };
  const goodEase = JSON.stringify({
    adjust: true,
    summary: "Ease back",
    rationale: "fatigue, deload",
    edit_request: "Reduce next week volume ~15% and turn Thursday tempo into easy.",
    decision_frame: { question: "Ease it?", options: [{ key: "accept", label: "Yes" }, { key: "keep", label: "Keep" }] },
  });

  test("adjust:false matches a stable fixture", () => {
    expect(checkRetro('{"adjust": false}', { ...base, expect: { adjust: false } }).pass).toBe(true);
  });
  test("expected adjust but model declined → fail", () => {
    expect(checkRetro('{"adjust": false}', { ...base, expect: { adjust: true } }).pass).toBe(false);
  });
  test("ease proposal under fatigue passes (no load increase)", () => {
    expect(checkRetro(goodEase, { ...base, expect: { adjust: true, noLoadIncrease: true } }).pass).toBe(true);
  });
  test("a load INCREASE under fatigue fails no_load_increase", () => {
    const bad = JSON.stringify({
      adjust: true,
      summary: "Push on",
      rationale: "looking strong",
      edit_request: "Increase next week's volume by 20% and add a second tempo.",
      decision_frame: { question: "Add load?", options: [{ key: "accept", label: "Yes" }, { key: "keep", label: "Keep" }] },
    });
    const v = checkRetro(bad, { ...base, expect: { adjust: true, noLoadIncrease: true } });
    expect(v.pass).toBe(false);
    expect(v.checks.find((c) => c.id === "no_load_increase")!.pass).toBe(false);
  });
  test("missing 'accept' option key fails frame_has_accept", () => {
    const noAccept = JSON.stringify({
      adjust: true,
      summary: "Ease",
      rationale: "fatigue",
      edit_request: "Reduce volume.",
      decision_frame: { question: "Ease?", options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }] },
    });
    const v = checkRetro(noAccept, { ...base, expect: { adjust: true, noLoadIncrease: true } });
    expect(v.checks.find((c) => c.id === "frame_has_accept")!.pass).toBe(false);
  });
});
