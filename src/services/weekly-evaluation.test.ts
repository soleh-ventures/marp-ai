import { describe, expect, test } from "bun:test";
import {
  looksLikeRevertRequest,
  looksLikeWeekReviewRequest,
  parseEvaluation,
} from "./weekly-evaluation.js";

describe("parseEvaluation", () => {
  test("parses a full adjust decision", () => {
    const raw = JSON.stringify({
      evaluation: "Solid week — you nailed 4 of 5 sessions.",
      adjust: true,
      safety_hold: false,
      change_summary: "easing next week's long run to 12k",
      rationale: "two short long runs in a row suggests the jump was too big",
      edit_request: "in week 5, cut the Saturday long run from 16k to 12k",
    });
    const d = parseEvaluation(raw);
    expect(d.evaluation).toContain("Solid week");
    expect(d.adjust).toBe(true);
    expect(d.safetyHold).toBe(false);
    expect(d.editRequest).toContain("cut the Saturday long run");
  });

  test("no-adjust week → adjust false, empty edit", () => {
    const d = parseEvaluation('{"evaluation":"On track, keep going.","adjust":false}');
    expect(d.evaluation).toContain("On track");
    expect(d.adjust).toBe(false);
    expect(d.editRequest).toBe("");
  });

  test("safety_hold is surfaced and never carries an auto-apply edit", () => {
    const d = parseEvaluation(
      '{"evaluation":"That knee pain matters.","adjust":true,"safety_hold":true,"change_summary":"back off until seen","rationale":"pain 3 runs running","edit_request":""}',
    );
    expect(d.safetyHold).toBe(true);
    expect(d.editRequest).toBe("");
  });

  test("tolerates markdown fences", () => {
    const d = parseEvaluation('```json\n{"evaluation":"hi","adjust":false}\n```');
    expect(d.evaluation).toBe("hi");
  });

  test("malformed payload → safe empty (no adjust)", () => {
    expect(parseEvaluation("not json").evaluation).toBe("");
    expect(parseEvaluation("not json").adjust).toBe(false);
  });
});

describe("looksLikeWeekReviewRequest", () => {
  const yes = [
    "how did my week go?",
    "how was my week",
    "evaluate my week",
    "weekly recap please",
    "weekly review",
    "review my week",
    "how was my training week",
    "how did I do this week",
  ];
  for (const m of yes) {
    test(`fires on: "${m}"`, () => expect(looksLikeWeekReviewRequest(m)).toBe(true));
  }

  const no = [
    "how do I taper for race week",
    "what's my plan for the week",
    "how was my run today",
    "how's it going",
    "what should I do this weekend",
  ];
  for (const m of no) {
    test(`stays quiet on: "${m}"`, () => expect(looksLikeWeekReviewRequest(m)).toBe(false));
  }
});

describe("looksLikeRevertRequest", () => {
  const yes = [
    "keep it as it was",
    "keep it the same",
    "leave it as is",
    "don't change my plan",
    "revert that",
    "undo the change",
    "put it back",
    "change it back",
  ];
  for (const m of yes) {
    test(`fires on: "${m}"`, () => expect(looksLikeRevertRequest(m)).toBe(true));
  }

  const no = [
    "what's my plan",
    "can you change my long run to Sunday",
    "how did my week go",
    "thanks coach",
  ];
  for (const m of no) {
    test(`stays quiet on: "${m}"`, () => expect(looksLikeRevertRequest(m)).toBe(false));
  }
});
