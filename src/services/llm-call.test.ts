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
