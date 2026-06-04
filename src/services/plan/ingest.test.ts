import { describe, expect, test } from "bun:test";
import { parseIngestResponse } from "./ingest.js";

const validIngestedPlan = JSON.stringify({
  source: "ingested",
  start_date: "2026-06-08",
  weeks: [
    {
      index: 1,
      sessions: [
        { day_of_week: "monday", type: "rest", description: "Rest" },
        { day_of_week: "tuesday", type: "easy", description: "5K easy" },
      ],
    },
  ],
});

describe("parseIngestResponse — happy path", () => {
  test("parses a clean JSON response", () => {
    const result = parseIngestResponse(validIngestedPlan);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.source).toBe("ingested");
      expect(result.plan.weeks).toHaveLength(1);
    }
  });

  test("strips markdown fences from a fenced response", () => {
    const fenced = "```json\n" + validIngestedPlan + "\n```";
    const result = parseIngestResponse(fenced);
    expect(result.ok).toBe(true);
  });
});

describe("parseIngestResponse — error paths", () => {
  test("returns not_a_plan when the LLM emits the error envelope", () => {
    const result = parseIngestResponse(
      JSON.stringify({ error: "not_a_plan", message: "looks like a recipe" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_a_plan");
      expect(result.message).toContain("recipe");
    }
  });

  test("returns parse_failed for non-JSON response", () => {
    const result = parseIngestResponse("I don't know what to do");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("parse_failed");
    }
  });

  test("returns parse_failed when JSON shape doesn't match a plan", () => {
    const result = parseIngestResponse(JSON.stringify({ random: "stuff" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("parse_failed");
    }
  });
});
