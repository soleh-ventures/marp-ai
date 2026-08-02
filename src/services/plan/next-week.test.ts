import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { assertNotProductionDb } from "../../db/test-guard.js";
import { athletes } from "../../db/schema.js";
import { _resetProviderCache, mockProvider } from "../llm/index.js";
import { generateNextWeekPlan, looksLikeNextWeekPlanRequest } from "./next-week.js";

describe("looksLikeNextWeekPlanRequest (pure)", () => {
  test("catches upcoming-week plan/menu requests", () => {
    for (const s of [
      "build training plan for next week",
      "create my training plan for next week",
      "what's my menu for next week?",
      "can you plan next week for me",
      "give me next week's training",
      "my menu for the coming week",
      "what should I run next week",
      "this week's plan please",
      "make next week a bit easier plan wise",
    ]) {
      expect(looksLikeNextWeekPlanRequest(s)).toBe(true);
    }
  });

  test("does NOT catch past-week reviews or generic messages", () => {
    for (const s of [
      "how was my week?",
      "how did my training go this week",
      "weekly recap please",
      "build me a plan", // first-time build, no future-week framing
      "how do I run faster",
      "my knee hurts",
      "what's the weather next week", // future week but no planning intent
    ]) {
      expect(looksLikeNextWeekPlanRequest(s)).toBe(false);
    }
  });
});

describe("generateNextWeekPlan (DB + mock LLM)", () => {
  beforeAll(() => {
    (config.llm as { provider: "mock" | "anthropic" }).provider = "mock";
    _resetProviderCache();
  });

  beforeEach(async () => {
    assertNotProductionDb();
    await db.execute(sql`TRUNCATE TABLE activities, athletes RESTART IDENTITY CASCADE`);
    mockProvider.reset();
  });

  const TWO_WEEK_JSON = JSON.stringify({
    source: "generated",
    start_date: "2020-01-01", // deliberately wrong — code must override
    methodology: "recent-volume anchored, 80/20",
    open_questions: [],
    weeks: [
      {
        index: 1,
        phase: "base",
        total_km: 32,
        focus: "steady +8% off a clean block",
        sessions: [
          { day_of_week: "monday", type: "rest", description: "Rest" },
          { day_of_week: "tuesday", type: "easy", distance_km: 7, description: "Easy 7K @ 5:40/km, Z2, RPE 3-4", reasoning: "Z2 base" },
        ],
      },
      // A second week the model shouldn't have produced — must be trimmed.
      { index: 2, phase: "build", total_km: 40, focus: "extra", sessions: [{ day_of_week: "monday", type: "easy", distance_km: 8, description: "Easy 8K" }] },
    ],
  });

  test("returns ONE upcoming week with the code-computed start_date", async () => {
    const [a] = await db
      .insert(athletes)
      .values({ phone: "+15551117001", name: "Runner", timezone: "Europe/Berlin" })
      .returning();
    if (!a) throw new Error("athlete insert failed");
    mockProvider.setResponses([{ match: "upcoming week", text: TWO_WEEK_JSON }]);

    const plan = await generateNextWeekPlan({ athleteId: a.id, messageId: null });
    // Capped to a single week even though the model returned two.
    expect(plan.weeks).toHaveLength(1);
    expect(plan.weeks[0]?.sessions.length).toBeGreaterThanOrEqual(2);
    // start_date overridden to a real upcoming Monday, not the model's 2020 date.
    expect(plan.start_date).not.toBe("2020-01-01");
    expect(plan.start_date >= "2026-01-01").toBe(true);
    expect(new Date(plan.start_date).getUTCDay()).toBe(1); // Monday
  });
});
