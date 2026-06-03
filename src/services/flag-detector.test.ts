import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { activeFlags, athletes, llmCalls, messages } from "../db/schema.js";
import {
  _resetFlagDetectorPromptCache,
  detectFlags,
  parseFlagsJson,
} from "./flag-detector.js";
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
  _resetFlagDetectorPromptCache();
});

// ── Pure JSON parsing ────────────────────────────────────────────────────

describe("parseFlagsJson", () => {
  test("happy path with single flag", () => {
    const r = parseFlagsJson(
      '{"flags":[{"kind":"injury","body":"left achilles tight","started_at":null}]}',
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.kind).toBe("injury");
    expect(r[0]?.body).toBe("left achilles tight");
    expect(r[0]?.startedAt).toBeNull();
  });

  test("parses ISO date in started_at", () => {
    const r = parseFlagsJson(
      '{"flags":[{"kind":"travel","body":"Bali trip","started_at":"2026-06-15"}]}',
    );
    expect(r[0]?.startedAt?.toISOString().slice(0, 10)).toBe("2026-06-15");
  });

  test("empty flags array yields zero results", () => {
    expect(parseFlagsJson('{"flags":[]}')).toEqual([]);
  });

  test("strips markdown fences", () => {
    const r = parseFlagsJson(
      '```json\n{"flags":[{"kind":"illness","body":"flu"}]}\n```',
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.kind).toBe("illness");
  });

  test("drops flags with invalid kind", () => {
    const r = parseFlagsJson(
      '{"flags":[{"kind":"tarot","body":"x"},{"kind":"injury","body":"y"}]}',
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.kind).toBe("injury");
  });

  test("drops flags with missing or empty body", () => {
    const r = parseFlagsJson(
      '{"flags":[{"kind":"injury","body":""},{"kind":"injury","body":"  "},{"kind":"injury"}]}',
    );
    expect(r).toEqual([]);
  });

  test("returns empty array on non-JSON input", () => {
    expect(parseFlagsJson("nope")).toEqual([]);
  });

  test("returns empty array on malformed JSON", () => {
    expect(parseFlagsJson("{not real")).toEqual([]);
  });

  test("returns empty array when 'flags' is missing or wrong shape", () => {
    expect(parseFlagsJson('{"something":[]}')).toEqual([]);
    expect(parseFlagsJson('{"flags":"not an array"}')).toEqual([]);
  });

  test("rejects garbage started_at without dropping the flag", () => {
    const r = parseFlagsJson(
      '{"flags":[{"kind":"injury","body":"x","started_at":"not a date"}]}',
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.startedAt).toBeNull();
  });
});

// ── Integration against DB + mock provider ───────────────────────────────

async function seed() {
  const [a] = await db
    .insert(athletes)
    .values({ phone: "+15551110400", name: "Flag Detector" })
    .returning();
  if (!a) throw new Error("athlete failed");
  const [inbound] = await db
    .insert(messages)
    .values({
      athleteId: a.id,
      direction: "in",
      body: "(per test)",
      twilioMessageSid: "SM-flag-in-1",
    })
    .returning();
  if (!inbound) throw new Error("inbound failed");
  return { athlete: a, inbound };
}

describe("detectFlags", () => {
  test("creates an active_flags row when the LLM returns a flag", async () => {
    const { athlete, inbound } = await seed();
    mockProvider.setResponses([
      {
        match: /.*/,
        text: '{"flags":[{"kind":"injury","body":"left achilles tight","started_at":null}]}',
      },
    ]);
    const r = await detectFlags(athlete.id, inbound.id, "my Achilles is sore");
    expect(r.created).toHaveLength(1);
    expect(r.created[0]?.kind).toBe("injury");
    expect(r.created[0]?.body).toBe("left achilles tight");

    const rows = await db
      .select()
      .from(activeFlags)
      .where(eq(activeFlags.athleteId, athlete.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolvedAt).toBeNull();
  });

  test("returns empty result when LLM returns no flags (and writes nothing)", async () => {
    const { athlete, inbound } = await seed();
    mockProvider.setResponses([{ match: /.*/, text: '{"flags":[]}' }]);
    const r = await detectFlags(athlete.id, inbound.id, "good run today");
    expect(r.created).toEqual([]);
    expect(
      await db
        .select()
        .from(activeFlags)
        .where(eq(activeFlags.athleteId, athlete.id)),
    ).toEqual([]);
  });

  test("hands existing open flags to the prompt for dedupe", async () => {
    const { athlete, inbound } = await seed();
    await db.insert(activeFlags).values({
      athleteId: athlete.id,
      kind: "injury",
      body: "left achilles tight",
    });
    mockProvider.setResponses([{ match: /.*/, text: '{"flags":[]}' }]);
    await detectFlags(athlete.id, inbound.id, "achilles still bugging me");

    // Verify the prompt the LLM saw included the existing flag.
    expect(mockProvider.calls).toHaveLength(1);
    const userPayload = mockProvider.calls[0]?.user ?? "";
    expect(userPayload).toContain("Existing open flags");
    expect(userPayload).toContain("achilles");
  });

  test("does NOT include already-resolved flags in the prompt context", async () => {
    const { athlete, inbound } = await seed();
    await db.insert(activeFlags).values({
      athleteId: athlete.id,
      kind: "illness",
      body: "had a cold last month",
      resolvedAt: new Date(),
    });
    mockProvider.setResponses([{ match: /.*/, text: '{"flags":[]}' }]);
    await detectFlags(athlete.id, inbound.id, "feeling fine");

    const userPayload = mockProvider.calls[0]?.user ?? "";
    expect(userPayload).toContain("Existing open flags\n[]");
    expect(userPayload).not.toContain("had a cold last month");
  });

  test("records llm_calls telemetry under component=memory", async () => {
    const { athlete, inbound } = await seed();
    mockProvider.setResponses([{ match: /.*/, text: '{"flags":[]}' }]);
    await detectFlags(athlete.id, inbound.id, "anything");
    const calls = await db.select().from(llmCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.component).toBe("memory");
    expect(calls[0]?.athleteId).toBe(athlete.id);
    expect(calls[0]?.messageId).toBe(inbound.id);
  });

  test("empty body short-circuits without an LLM call", async () => {
    const { athlete, inbound } = await seed();
    const r = await detectFlags(athlete.id, inbound.id, "   ");
    expect(r.created).toEqual([]);
    expect(mockProvider.calls).toHaveLength(0);
  });

  test("inserts multiple flags in one call", async () => {
    const { athlete, inbound } = await seed();
    mockProvider.setResponses([
      {
        match: /.*/,
        text: '{"flags":[{"kind":"injury","body":"shin tight"},{"kind":"travel","body":"bali trip friday"}]}',
      },
    ]);
    const r = await detectFlags(
      athlete.id,
      inbound.id,
      "shin's tight + heading to bali friday",
    );
    expect(r.created).toHaveLength(2);
    const rows = await db
      .select()
      .from(activeFlags)
      .where(eq(activeFlags.athleteId, athlete.id));
    expect(rows).toHaveLength(2);
  });

  test("survives garbage LLM output without throwing", async () => {
    const { athlete, inbound } = await seed();
    mockProvider.setResponses([
      { match: /.*/, text: "sorry, I don't understand" },
    ]);
    const r = await detectFlags(athlete.id, inbound.id, "anything");
    expect(r.created).toEqual([]);
    // No partial writes.
    expect(
      await db
        .select()
        .from(activeFlags)
        .where(eq(activeFlags.athleteId, athlete.id)),
    ).toEqual([]);
  });
});
