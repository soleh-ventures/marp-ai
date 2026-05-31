import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { athletes, messages } from "../db/schema.js";
import { _resetProviderCache, mockProvider } from "../services/llm/index.js";
import {
  getAthleticHistory,
  isOnboarded,
  parseOnboardingResponse,
  runOnboardingTurn,
} from "./onboarding.js";

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

describe("parseOnboardingResponse", () => {
  test("happy path", () => {
    const r = parseOnboardingResponse(
      '{"extracted":{"name":"Sarah","age":32},"next_section":"fitness","reply":"Nice to meet you Sarah."}',
    );
    expect(r.extracted).toEqual({ name: "Sarah", age: 32 });
    expect(r.next_section).toBe("fitness");
    expect(r.reply).toBe("Nice to meet you Sarah.");
  });

  test("strips markdown fences", () => {
    const r = parseOnboardingResponse(
      '```json\n{"extracted":{},"next_section":"basics","reply":"hi"}\n```',
    );
    expect(r.reply).toBe("hi");
  });

  test("invalid next_section falls back to basics", () => {
    const r = parseOnboardingResponse(
      '{"extracted":{},"next_section":"galaxy_brain","reply":"hi"}',
    );
    expect(r.next_section).toBe("basics");
  });

  test("throws on missing reply", () => {
    expect(() =>
      parseOnboardingResponse(
        '{"extracted":{},"next_section":"basics","reply":""}',
      ),
    ).toThrow();
  });

  test("throws on non-JSON", () => {
    expect(() => parseOnboardingResponse("Hello there!")).toThrow();
  });
});

describe("isOnboarded", () => {
  test("returns false when no history", () => {
    expect(isOnboarded({})).toBe(false);
  });
  test("returns false when in_progress", () => {
    expect(
      isOnboarded({
        onboarding: {
          status: "in_progress",
          current_section: "basics",
          started_at: "2026-05-25T00:00:00Z",
          turn_count: 1,
        },
      }),
    ).toBe(false);
  });
  test("returns true when complete", () => {
    expect(
      isOnboarded({
        onboarding: {
          status: "complete",
          current_section: "complete",
          started_at: "2026-05-25T00:00:00Z",
          turn_count: 5,
        },
      }),
    ).toBe(true);
  });
});

async function makeAthleteWithMessage(message: string) {
  const [a] = await db
    .insert(athletes)
    .values({ phone: "+15551110001" })
    .returning();
  if (!a) throw new Error("athlete insert failed");
  const [m] = await db
    .insert(messages)
    .values({ athleteId: a.id, direction: "in", body: message })
    .returning();
  if (!m) throw new Error("message insert failed");
  return { athleteId: a.id, messageId: m.id };
}

async function reloadHistory(athleteId: string) {
  const rows = await db
    .select({ name: athletes.name, history: athletes.athleticHistory })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  return rows[0];
}

describe("runOnboardingTurn", () => {
  test("first turn — extracts name + advances section + persists meta", async () => {
    const { athleteId, messageId } = await makeAthleteWithMessage(
      "hi i'm Sarah, training for the Jakarta marathon in October",
    );
    mockProvider.setResponses([
      {
        match: /.*/,
        text: '{"extracted":{"name":"Sarah","target_race":{"name":"Jakarta Marathon","distance":"marathon"}},"next_section":"basics","reply":"Nice to meet you, Sarah. How old are you, and how many days a week can you train?"}',
      },
    ]);
    const r = await runOnboardingTurn(athleteId, messageId, "hi i'm Sarah");
    expect(r.finishedThisTurn).toBe(false);
    expect(r.reply).toContain("Sarah");

    const row = await reloadHistory(athleteId);
    expect(row?.name).toBe("Sarah");
    const h = getAthleticHistory(row?.history);
    expect(h.name).toBe("Sarah");
    expect(h.onboarding?.status).toBe("in_progress");
    expect(h.onboarding?.turn_count).toBe(1);
    expect(h.onboarding?.current_section).toBe("basics");
  });

  test("merges across turns — arrays append, scalars overwrite", async () => {
    const { athleteId, messageId } = await makeAthleteWithMessage("anything");
    mockProvider.setResponses([
      {
        match: /.*/,
        text: '{"extracted":{"age":32,"past_injuries":["IT band 2023"]},"next_section":"injury","reply":"q1"}',
      },
    ]);
    await runOnboardingTurn(athleteId, messageId, "first message");

    mockProvider.setResponses([
      {
        match: /.*/,
        text: '{"extracted":{"age":33,"past_injuries":["plantar 2024"]},"next_section":"injury","reply":"q2"}',
      },
    ]);
    await runOnboardingTurn(athleteId, messageId, "second message");

    const row = await reloadHistory(athleteId);
    const h = getAthleticHistory(row?.history);
    // Scalar overwritten with latest.
    expect(h.age).toBe(33);
    // Array appended.
    expect(h.past_injuries).toEqual(["IT band 2023", "plantar 2024"]);
    expect(h.onboarding?.turn_count).toBe(2);
  });

  test("next_section=complete flips status and finishedThisTurn", async () => {
    const { athleteId, messageId } = await makeAthleteWithMessage("ok");
    mockProvider.setResponses([
      {
        match: /.*/,
        text: '{"extracted":{},"next_section":"complete","reply":"All set — let\'s start with a 20-min easy run tomorrow."}',
      },
    ]);
    const r = await runOnboardingTurn(athleteId, messageId, "ok");
    expect(r.finishedThisTurn).toBe(true);

    const row = await reloadHistory(athleteId);
    const h = getAthleticHistory(row?.history);
    expect(h.onboarding?.status).toBe("complete");
    expect(h.onboarding?.current_section).toBe("complete");
    expect(isOnboarded(h)).toBe(true);
  });

  test("force-completes after MAX_ONBOARDING_TURNS", async () => {
    const { athleteId, messageId } = await makeAthleteWithMessage("hi");
    // Pre-seed turn_count to one below the cap so the next turn trips it.
    await db
      .update(athletes)
      .set({
        athleticHistory: {
          onboarding: {
            status: "in_progress",
            current_section: "fitness",
            started_at: new Date().toISOString(),
            turn_count: 11,
          },
        },
      })
      .where(eq(athletes.id, athleteId));

    mockProvider.setResponses([
      {
        match: /.*/,
        // LLM tries to keep onboarding going. The cap should override.
        text: '{"extracted":{},"next_section":"basics","reply":"one more thing…"}',
      },
    ]);
    const r = await runOnboardingTurn(athleteId, messageId, "hi");
    expect(r.finishedThisTurn).toBe(true);
    const row = await reloadHistory(athleteId);
    const h = getAthleticHistory(row?.history);
    expect(h.onboarding?.status).toBe("complete");
  });
});
