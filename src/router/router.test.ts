import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { athletes, llmCalls, messages } from "../db/schema.js";
import { _resetProviderCache, mockProvider } from "../services/llm/index.js";
import { route } from "./index.js";

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

async function makeAthleteAndMessage(body: string) {
  const [a] = await db
    .insert(athletes)
    .values({ phone: `+155512${Math.floor(Math.random() * 100000)}` })
    .returning();
  if (!a) throw new Error("athlete insert failed");
  const [m] = await db
    .insert(messages)
    .values({ athleteId: a.id, direction: "in", body })
    .returning();
  if (!m) throw new Error("message insert failed");
  return { athleteId: a.id, messageId: m.id };
}

describe("router.route — single domain", () => {
  test("classifier picks 1 domain → 2 LLM calls (classifier + 1 domain), no synthesizer", async () => {
    const { athleteId, messageId } = await makeAthleteAndMessage(
      "how do i taper for race week",
    );

    // Order matters — first substring match wins. The domain payload
    // contains "# Message\n…" plus the bare message, so put the more
    // specific match first; the bare message only matches the classifier.
    mockProvider.setResponses([
      {
        match: "# Message\nhow do i taper",
        text: "Cut volume to ~60% week -2, keep intensity, sleep more.",
      },
      {
        match: "how do i taper",
        text: '{"domains":["training"],"confidence":0.95,"rationale":"taper question"}',
      },
    ]);

    const result = await route({
      message: "how do i taper for race week",
      athleteId,
      messageId,
    });

    expect(result.routing.domains).toEqual(["training"]);
    expect(result.domainAnswers).toHaveLength(1);
    expect(result.domainAnswers[0]?.domain).toBe("training");
    expect(result.finalText).toBe(
      "Cut volume to ~60% week -2, keep intensity, sleep more.",
    );
    expect(result.llmCallCount).toBe(2);

    // 2 provider calls total
    expect(mockProvider.calls).toHaveLength(2);
    expect(mockProvider.calls[0]?.model).toBe(config.llm.classifierModel);
    expect(mockProvider.calls[1]?.model).toBe(config.llm.domainModel);

    // 2 llm_calls rows persisted with correct components
    const rows = await db
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.athleteId, athleteId));
    expect(rows).toHaveLength(2);
    const components = rows.map((r) => r.component).sort();
    expect(components).toEqual(["classifier", "domain"]);
  });
});

describe("router.route — multi-domain", () => {
  test("classifier picks 2 domains → 4 LLM calls (1 cls + 2 domain + 1 synth) in parallel", async () => {
    const { athleteId, messageId } = await makeAthleteAndMessage(
      "my shin is killing me and i'm freaking out about saturday's race",
    );

    // Both domain calls share the same user payload (the runner's message
    // wrapped in "# Message\n…"). Domain prompts differ in the SYSTEM,
    // not the user — so we give both domain calls the same canned reply
    // and rely on the synthesizer to blend. Order matters: most-specific
    // matchers first.
    mockProvider.setResponses([
      {
        match: "# Expert answers",
        text: "FINAL_SYNTHESIZED_REPLY",
      },
      {
        match: "# Message\nmy shin is killing me",
        text: "DOMAIN_EXPERT_REPLY",
      },
      {
        match: "my shin is killing me",
        text: '{"domains":["injury","mental"],"confidence":0.85,"rationale":"shin pain + race anxiety"}',
      },
    ]);

    const result = await route({
      message: "my shin is killing me and i'm freaking out about saturday's race",
      athleteId,
      messageId,
    });

    expect(result.routing.domains).toEqual(["injury", "mental"]);
    expect(result.domainAnswers).toHaveLength(2);
    expect(result.domainAnswers.map((d) => d.domain).sort()).toEqual([
      "injury",
      "mental",
    ]);
    expect(result.finalText).toBe("FINAL_SYNTHESIZED_REPLY");
    expect(result.llmCallCount).toBe(4);

    expect(mockProvider.calls).toHaveLength(4);
    const models = mockProvider.calls.map((c) => c.model);
    expect(models[0]).toBe(config.llm.classifierModel);
    expect(models[1]).toBe(config.llm.domainModel);
    expect(models[2]).toBe(config.llm.domainModel);
    expect(models[3]).toBe(config.llm.synthesizerModel);

    // 4 llm_calls rows, one per call
    const rows = await db
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.athleteId, athleteId));
    expect(rows).toHaveLength(4);
    const componentCounts = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.component] = (acc[r.component] ?? 0) + 1;
      return acc;
    }, {});
    expect(componentCounts).toEqual({
      classifier: 1,
      domain: 2,
      synthesizer: 1,
    });
  });
});

describe("router.route — cost telemetry", () => {
  test("every persisted llm_calls row has non-negative cost_estimate_usd and latency_ms", async () => {
    const { athleteId, messageId } = await makeAthleteAndMessage(
      "should i run today?",
    );
    mockProvider.setResponses([
      {
        match: "# Message\nshould i run today",
        text: "Yes — easy 30 min, keep HR < 140.",
      },
      {
        match: "should i run today",
        text: '{"domains":["training"],"confidence":0.7,"rationale":"go/no-go"}',
      },
    ]);
    await route({ message: "should i run today?", athleteId, messageId });

    const rows = await db
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.athleteId, athleteId));
    for (const r of rows) {
      expect(r.tokensIn).toBeGreaterThan(0);
      expect(r.tokensOut).toBeGreaterThan(0);
      expect(r.costEstimateUsd).toBeGreaterThanOrEqual(0);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
      expect(r.model).toBeTruthy();
      expect(r.messageId).toBe(messageId);
    }
  });
});
