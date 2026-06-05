import { describe, expect, test } from "bun:test";
import {
  PIVOT_QUESTION,
  PIVOT_QUESTION_SIGNATURE,
  classifyPivotReply,
  getPivotState,
  isAwaitingPivotChoice,
  withPivotState,
} from "./post-onboarding-pivot.js";

describe("PIVOT_QUESTION", () => {
  test("contains the signature so detection can match on it", () => {
    expect(PIVOT_QUESTION).toContain(PIVOT_QUESTION_SIGNATURE);
  });

  test("offers both paths (a and b) clearly", () => {
    expect(PIVOT_QUESTION).toContain("(a)");
    expect(PIVOT_QUESTION).toContain("(b)");
  });

  test("starts with two newlines so it visually separates from preceding content", () => {
    expect(PIVOT_QUESTION.startsWith("\n\n")).toBe(true);
  });
});

describe("classifyPivotReply — BYO patterns", () => {
  test.each([
    "a",
    "A",
    "a.",
    "a)",
    "I have a plan",
    "I've got a plan",
    "I already have one",
    "got my own",
    "Coach me through it",
    "bring my own plan",
  ])("treats %p as BYO", (input) => {
    expect(classifyPivotReply(input)).toBe("byo");
  });
});

describe("classifyPivotReply — build patterns", () => {
  test.each([
    "b",
    "B",
    "b.",
    "b)",
    "Build one for me",
    "Make me a plan",
    "Build it from scratch",
    "From scratch",
    "you build it",
    "Generate a plan",
  ])("treats %p as build", (input) => {
    expect(classifyPivotReply(input)).toBe("build");
  });
});

describe("classifyPivotReply — other / fall-through", () => {
  test.each([
    "Hi",
    "tell me more",
    "What does that mean",
    "Can you explain",
    "I'm tired",
    "🤔",
  ])("falls through to other for %p (runner gets routed to expert)", (input) => {
    expect(classifyPivotReply(input)).toBe("other");
  });
});

describe("isAwaitingPivotChoice", () => {
  test("true when lastOutbound has the pivot signature and no pivot_state yet", () => {
    const out = `Welcome! ${PIVOT_QUESTION}`;
    expect(isAwaitingPivotChoice(out, {})).toBe(true);
  });

  test("false when pivot_state has already advanced past awaiting_choice", () => {
    const out = `Welcome! ${PIVOT_QUESTION}`;
    expect(isAwaitingPivotChoice(out, { pivot_state: "awaiting_plan" })).toBe(
      false,
    );
    expect(isAwaitingPivotChoice(out, { pivot_state: "build_pending" })).toBe(
      false,
    );
    expect(isAwaitingPivotChoice(out, { pivot_state: "done" })).toBe(false);
  });

  test("false when lastOutbound is unrelated", () => {
    expect(isAwaitingPivotChoice("Got it. Anything else?", {})).toBe(false);
  });

  test("false when lastOutbound is null", () => {
    expect(isAwaitingPivotChoice(null, {})).toBe(false);
  });
});

describe("withPivotState / getPivotState", () => {
  test("round-trips pivot_state through history", () => {
    const updated = withPivotState({}, "awaiting_choice");
    expect(getPivotState(updated)).toBe("awaiting_choice");
  });

  test("preserves other history keys", () => {
    const updated = withPivotState(
      { name: "Sam", target_race: "Berlin" },
      "build_pending",
    );
    expect(updated.name).toBe("Sam");
    expect(updated.target_race).toBe("Berlin");
    expect(getPivotState(updated)).toBe("build_pending");
  });

  test("getPivotState returns undefined for an invalid value", () => {
    expect(getPivotState({ pivot_state: "garbage" })).toBeUndefined();
    expect(getPivotState({})).toBeUndefined();
  });
});
