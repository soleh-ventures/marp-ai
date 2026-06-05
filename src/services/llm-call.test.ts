import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { llmCalls } from "../db/schema.js";
import { llmCall } from "./llm-call.js";
import { _resetProviderCache, mockProvider } from "./llm/index.js";

beforeAll(() => {
  (config.llm as { provider: "mock" | "anthropic" }).provider = "mock";
  _resetProviderCache();
});

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`
    TRUNCATE TABLE
      llm_calls, processed_messages, messages, active_flags,
      activities, race_blocks, strava_connections,
      pending_decisions, athletes
    RESTART IDENTITY CASCADE
  `);
  mockProvider.reset();
});

describe("llmCall — T6 cache telemetry", () => {
  test("persists cache_hit and cache_read_tokens columns on every row", async () => {
    mockProvider.setResponses([{ match: /.*/, text: "ok" }]);
    await llmCall(
      {
        model: "mock",
        system: "sys",
        user: "hello",
        maxTokens: 10,
        cacheSystem: true,
      },
      { component: "classifier" },
    );
    const rows = await db.select().from(llmCalls);
    expect(rows).toHaveLength(1);
    // Mock provider always reports no caching; the column is populated
    // with the mock's defaults (false / 0) — proves the column persists
    // and isn't NULL.
    expect(rows[0]?.cacheHit).toBe(false);
    expect(rows[0]?.cacheReadTokens).toBe(0);
  });
});

describe("llmCall — I/O capture for answer-quality debugging", () => {
  test("persists input_user and output_text so a reply can be traced to its prompt", async () => {
    mockProvider.setResponses([{ match: /.*/, text: "rest 3 days" }]);
    await llmCall(
      {
        model: "mock",
        system: "you are a coach",
        user: "achilles is sore, what do I do",
        maxTokens: 50,
      },
      { component: "domain" },
    );
    const rows = await db.select().from(llmCalls);
    expect(rows).toHaveLength(1);
    // We store the dynamic user payload (carries runner context) and the
    // model reply. The system prompt is intentionally NOT stored — it's
    // recoverable from git via `component`.
    expect(rows[0]?.inputUser).toBe("achilles is sore, what do I do");
    expect(rows[0]?.outputText).toBe("rest 3 days");
  });

  test("truncates oversized I/O text with a marker to bound row size", async () => {
    const huge = "x".repeat(120_000);
    mockProvider.setResponses([{ match: /.*/, text: huge }]);
    await llmCall(
      { model: "mock", system: "sys", user: huge, maxTokens: 10 },
      { component: "other" },
    );
    const rows = await db.select().from(llmCalls);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputUser).toContain("[truncated 20000 chars]");
    expect(rows[0]?.outputText).toContain("[truncated 20000 chars]");
    // Capped at 100k + the marker suffix, never the full 120k.
    expect((rows[0]?.inputUser?.length ?? 0)).toBeLessThan(120_000);
  });
});
