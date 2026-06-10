import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { athletes } from "../db/schema.js";
import { _resetProviderCache, mockProvider } from "./llm/index.js";
import { classifyPivotIntent, fastPathChoice } from "./pivot-intent.js";

describe("fastPathChoice (pure — bare tap only)", () => {
  test.each(["a", "A", "a.", "a)", "(a)", " a ", "(A)."])(
    "%p → byo",
    (input) => {
      expect(fastPathChoice(input)).toBe("byo");
    },
  );

  test.each(["b", "B", "b.", "b)", "(b)", " b ", "(B)."])(
    "%p → build",
    (input) => {
      expect(fastPathChoice(input)).toBe("build");
    },
  );

  test.each([
    // The dogfood bug input: a letter PLUS real content must NOT fast-path —
    // it goes to the LLM read so the trailing clause can't be mis-decided.
    "(B) but my first day should be June 3rd",
    "a tempo run please",
    "build it",
    "I have a plan",
    "first option",
    "",
  ])("%p → null (defers to LLM)", (input) => {
    expect(fastPathChoice(input)).toBeNull();
  });
});

describe("classifyPivotIntent (LLM read via mock)", () => {
  beforeAll(() => {
    (config.llm as { provider: "mock" | "anthropic" }).provider = "mock";
    _resetProviderCache();
  });

  beforeEach(async () => {
    assertNotProductionDb();
    await db.execute(sql`
      TRUNCATE TABLE llm_calls, athletes RESTART IDENTITY CASCADE
    `);
    mockProvider.reset();
  });

  async function seedAthlete(): Promise<string> {
    const [a] = await db
      .insert(athletes)
      .values({ phone: "whatsapp:+10000000000", athleticHistory: {} })
      .returning({ id: athletes.id });
    return a!.id;
  }

  test("reads explicit (b)+date as build, not byo", async () => {
    const athleteId = await seedAthlete();
    mockProvider.setResponses([
      { match: "first day", text: '{"intent":"build","reply":null}' },
    ]);
    const r = await classifyPivotIntent({
      athleteId,
      messageId: null,
      body: "(b) but my first day should be June 3rd",
      phase: "choice",
    });
    expect(r.intent).toBe("build");
    expect(r.reply).toBeNull();
  });

  test("byo carries a coach-voice ack through", async () => {
    const athleteId = await seedAthlete();
    mockProvider.setResponses([
      {
        match: "Higdon",
        text: '{"intent":"byo","reply":"Nice — send it over whenever, week-by-week or a summary."}',
      },
    ]);
    const r = await classifyPivotIntent({
      athleteId,
      messageId: null,
      body: "I follow a Hal Higdon plan",
      phase: "choice",
    });
    expect(r.intent).toBe("byo");
    expect(r.reply).toContain("send it over");
  });

  test("a non-byo intent never carries a reply even if the model emits one", async () => {
    const athleteId = await seedAthlete();
    mockProvider.setResponses([
      { match: "build", text: '{"intent":"build","reply":"ignored"}' },
    ]);
    const r = await classifyPivotIntent({
      athleteId,
      messageId: null,
      body: "just build it",
      phase: "choice",
    });
    expect(r.intent).toBe("build");
    expect(r.reply).toBeNull();
  });

  test("LLM failure falls back deterministically (build keyword) — never throws", async () => {
    const athleteId = await seedAthlete();
    // No canned response → mock throws → fallback path.
    const r = await classifyPivotIntent({
      athleteId,
      messageId: null,
      body: "build me a training plan",
      phase: "choice",
    });
    expect(r.intent).toBe("build");
    expect(r.reply).toBeNull();
  });

  test("fallback in choice phase routes an opaque message to question (no trap)", async () => {
    const athleteId = await seedAthlete();
    const r = await classifyPivotIntent({
      athleteId,
      messageId: null,
      body: "what do you mean exactly?",
      phase: "choice",
    });
    expect(r.intent).toBe("question");
  });

  test("fallback while awaiting_plan treats an opaque message as plan content", async () => {
    const athleteId = await seedAthlete();
    const r = await classifyPivotIntent({
      athleteId,
      messageId: null,
      body: "here is the thing I mentioned",
      phase: "awaiting_plan",
    });
    expect(r.intent).toBe("plan_content");
  });
});
