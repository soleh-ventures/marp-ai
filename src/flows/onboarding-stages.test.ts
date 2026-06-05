import { describe, expect, test } from "bun:test";
import {
  STAGE_INDEX,
  STAGE_RATIONALE,
  TOTAL_STAGES,
  appendProgressTail,
  buildProgressTail,
} from "./onboarding-stages.js";

describe("STAGE_INDEX", () => {
  test("covers all 6 productive stages plus complete", () => {
    expect(Object.keys(STAGE_INDEX).length).toBe(7);
  });

  test("productive stages are 1..6, complete is 7", () => {
    expect(STAGE_INDEX.basics).toBe(1);
    expect(STAGE_INDEX.fitness).toBe(2);
    expect(STAGE_INDEX.goal).toBe(3);
    expect(STAGE_INDEX.lifestyle).toBe(4);
    expect(STAGE_INDEX.injury).toBe(5);
    expect(STAGE_INDEX.accountability).toBe(6);
    expect(STAGE_INDEX.complete).toBe(7);
  });

  test("TOTAL_STAGES matches the productive count", () => {
    expect(TOTAL_STAGES).toBe(6);
  });
});

describe("STAGE_RATIONALE", () => {
  test("every productive stage has a rationale", () => {
    expect(STAGE_RATIONALE.basics).toBeDefined();
    expect(STAGE_RATIONALE.fitness).toBeDefined();
    expect(STAGE_RATIONALE.goal).toBeDefined();
    expect(STAGE_RATIONALE.lifestyle).toBeDefined();
    expect(STAGE_RATIONALE.injury).toBeDefined();
    expect(STAGE_RATIONALE.accountability).toBeDefined();
  });

  test("each rationale is short enough to read inline (under 100 chars)", () => {
    // Rationale lines that bloat past ~100 chars start to dominate the
    // chat and dilute the actual question.
    for (const [stage, rationale] of Object.entries(STAGE_RATIONALE)) {
      expect(rationale.length).toBeLessThan(100);
      // Guards against accidentally empty / placeholder copy
      expect(rationale.length).toBeGreaterThan(20);
      expect(rationale).not.toMatch(/^todo|^placeholder/i);
    }
  });
});

describe("buildProgressTail", () => {
  test("returns null when section is complete (wrap-up reply needs no tail)", () => {
    expect(buildProgressTail("complete")).toBeNull();
  });

  test("returns a tail containing the rationale + progress for productive stages", () => {
    const tail = buildProgressTail("basics");
    expect(tail).not.toBeNull();
    expect(tail).toContain("Why I ask");
    expect(tail).toContain(STAGE_RATIONALE.basics);
    expect(tail).toContain("Onboarding: 1 of 6");
  });

  test("progress index matches stage position for all productive stages", () => {
    expect(buildProgressTail("goal")).toContain("3 of 6");
    expect(buildProgressTail("accountability")).toContain("6 of 6");
  });

  test("starts with two newlines so it visually separates from the question above", () => {
    const tail = buildProgressTail("fitness");
    expect(tail?.startsWith("\n\n")).toBe(true);
  });
});

describe("appendProgressTail", () => {
  test("appends tail when section is productive", () => {
    const reply = "What's your name?";
    const result = appendProgressTail(reply, "basics");
    expect(result.startsWith(reply)).toBe(true);
    expect(result).toContain("Why I ask");
  });

  test("returns the reply unchanged when section is complete", () => {
    const reply = "Welcome! All set — what would you like to talk about?";
    expect(appendProgressTail(reply, "complete")).toBe(reply);
  });
});
