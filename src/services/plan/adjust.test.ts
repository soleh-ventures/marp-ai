import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { assertNotProductionDb } from "../../db/test-guard.js";
import { athletes, messages } from "../../db/schema.js";
import { _resetProviderCache, mockProvider } from "../llm/index.js";
import { adjustPlan } from "./adjust.js";
import { saveAthletePlan } from "./storage.js";
import { parsePlan, type Plan } from "./types.js";

beforeAll(() => {
  (config.llm as { provider: "mock" | "anthropic" }).provider = "mock";
  _resetProviderCache();
});

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`
    TRUNCATE TABLE
      llm_calls, processed_messages, messages, active_flags,
      activities, race_blocks, athletes
    RESTART IDENTITY CASCADE
  `);
  mockProvider.reset();
});

const basePlan: Plan = parsePlan({
  source: "generated",
  start_date: "2026-06-08",
  race_name: "Berlin Marathon",
  weeks: [
    {
      index: 1,
      sessions: [
        { day_of_week: "monday", type: "rest", description: "Rest" },
        { day_of_week: "sunday", type: "long", distance_km: 14, description: "14K long" },
      ],
    },
  ],
});

async function makeAthleteWithPlan(plan: Plan | null) {
  const [a] = await db
    .insert(athletes)
    .values({ phone: `+155512${Math.floor(Math.random() * 100000)}` })
    .returning();
  if (!a) throw new Error("athlete insert failed");
  if (plan) await saveAthletePlan(a.id, plan);
  const [m] = await db
    .insert(messages)
    .values({ athleteId: a.id, direction: "in", body: "edit" })
    .returning();
  if (!m) throw new Error("message insert failed");
  return { athleteId: a.id, messageId: m.id };
}

describe("adjustPlan (A1 targeted mutation)", () => {
  test("applies the edit and returns the modified plan", async () => {
    const { athleteId, messageId } = await makeAthleteWithPlan(basePlan);
    // Model moves the long run to Saturday.
    const modified = {
      ...basePlan,
      weeks: [
        {
          index: 1,
          sessions: [
            { day_of_week: "monday", type: "rest", description: "Rest" },
            { day_of_week: "saturday", type: "long", distance_km: 14, description: "14K long" },
          ],
        },
      ],
    };
    mockProvider.setResponses([
      { match: "move my long run", text: JSON.stringify(modified) },
    ]);

    const result = await adjustPlan({
      athleteId,
      messageId,
      editRequest: "move my long run to Saturday",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const longRun = result.plan.weeks[0]?.sessions.find((s) => s.type === "long");
      expect(longRun?.day_of_week).toBe("saturday");
    }
  });

  test("preserves the original start_date even if the model changes it", async () => {
    const { athleteId, messageId } = await makeAthleteWithPlan(basePlan);
    mockProvider.setResponses([
      // Model returns a bogus start_date — code must override it back.
      { match: "make it easier", text: JSON.stringify({ ...basePlan, start_date: "2099-01-01" }) },
    ]);
    const result = await adjustPlan({ athleteId, messageId, editRequest: "make it easier" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.start_date).toBe("2026-06-08");
  });

  test("returns no_plan when the runner has no stored plan yet", async () => {
    const { athleteId, messageId } = await makeAthleteWithPlan(null);
    const result = await adjustPlan({ athleteId, messageId, editRequest: "move my long run" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_plan");
  });

  test("returns parse_failed when the model never emits valid plan JSON", async () => {
    const { athleteId, messageId } = await makeAthleteWithPlan(basePlan);
    mockProvider.setResponses([{ match: "garble", text: "I cannot do that" }]);
    const result = await adjustPlan({ athleteId, messageId, editRequest: "garble it" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("parse_failed");
  });
});
