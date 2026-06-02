import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import {
  athletes,
  llmCalls,
  messages,
  pendingDecisions,
} from "../db/schema.js";
import { _resetProviderCache, mockProvider } from "./llm/index.js";
import {
  _resetBinderPromptCache,
  bindReply,
  parseBinderJson,
  tryExactMatch,
} from "./binder.js";
import { recordFrame } from "./pending-decisions.js";

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
  _resetBinderPromptCache();
});

const FRAME_TWO_OPTION = {
  question: "Rest or easy 5K?",
  options: [
    { key: "rest", label: "Rest day" },
    { key: "easy_5k", label: "Easy 5K" },
  ],
};
const FRAME_THREE_OPTION = {
  question: "Tempo, easy, or rest?",
  options: [
    { key: "tempo", label: "Run the tempo" },
    { key: "easy", label: "Easy 30min" },
    { key: "rest", label: "Full rest day" },
  ],
};

// ── Pure unit tests ──────────────────────────────────────────────────────

describe("tryExactMatch", () => {
  test("matches single-word key", () => {
    expect(tryExactMatch("rest", FRAME_TWO_OPTION)).toBe("rest");
  });

  test("matches the user-facing label (normalized)", () => {
    expect(tryExactMatch("Easy 5K", FRAME_TWO_OPTION)).toBe("easy_5k");
  });

  test("matches case-insensitively", () => {
    expect(tryExactMatch("REST", FRAME_TWO_OPTION)).toBe("rest");
  });

  test("converts snake_case key to space-separated for matching", () => {
    expect(tryExactMatch("easy 5k", FRAME_TWO_OPTION)).toBe("easy_5k");
  });

  test("ignores surrounding punctuation", () => {
    expect(tryExactMatch("Rest!", FRAME_TWO_OPTION)).toBe("rest");
  });

  test("returns null on ambiguous matches (two options match)", () => {
    // Hypothetical: if both labels collapse to the same normalized form
    // we should bail out rather than guess.
    const frame = {
      question: "x",
      options: [
        { key: "a", label: "Rest" },
        { key: "b", label: "Rest" },
      ],
    };
    expect(tryExactMatch("rest", frame)).toBeNull();
  });

  test("returns null when the reply doesn't match any token (defer to LLM)", () => {
    expect(tryExactMatch("skip it", FRAME_THREE_OPTION)).toBeNull();
  });

  test("returns null on empty / whitespace-only body", () => {
    expect(tryExactMatch("", FRAME_TWO_OPTION)).toBeNull();
    expect(tryExactMatch("   ", FRAME_TWO_OPTION)).toBeNull();
  });
});

describe("parseBinderJson", () => {
  test("happy path with key + reasoning", () => {
    expect(parseBinderJson('{"key":"rest","reasoning":"explicit rest"}')).toEqual(
      {
        key: "rest",
        reasoning: "explicit rest",
      },
    );
  });

  test("accepts null key", () => {
    expect(parseBinderJson('{"key":null,"reasoning":"unrelated"}')).toEqual({
      key: null,
    });
  });

  test("strips markdown fences", () => {
    expect(parseBinderJson('```json\n{"key":"rest"}\n```')).toEqual({
      key: "rest",
    });
  });

  test("returns null on non-JSON", () => {
    expect(parseBinderJson("I think the runner means rest")).toBeNull();
  });

  test("returns null on missing key field", () => {
    expect(parseBinderJson('{"reasoning":"x"}')).toBeNull();
  });

  test("returns null on empty-string key", () => {
    expect(parseBinderJson('{"key":""}')).toBeNull();
  });
});

// ── Integration tests against the DB + mock LLM provider ─────────────────

async function seed() {
  const [a] = await db
    .insert(athletes)
    .values({ phone: "+15551110300", name: "Binder Athlete" })
    .returning();
  if (!a) throw new Error("athlete insert failed");
  const [out] = await db
    .insert(messages)
    .values({
      athleteId: a.id,
      direction: "out",
      body: "MARP asked the question",
      twilioMessageSid: "SM-out-1",
    })
    .returning();
  if (!out) throw new Error("outbound insert failed");
  const frame = await recordFrame(a.id, out.id, FRAME_THREE_OPTION);
  const [inbound] = await db
    .insert(messages)
    .values({
      athleteId: a.id,
      direction: "in",
      body: "(set per test)",
      twilioMessageSid: "SM-in-1",
    })
    .returning();
  if (!inbound) throw new Error("inbound insert failed");
  return { athlete: a, frame, inbound };
}

describe("bindReply", () => {
  test("returns no_open_frames when athlete has no pending decisions", async () => {
    const [a] = await db
      .insert(athletes)
      .values({ phone: "+15551110301", name: "Solo" })
      .returning();
    if (!a) throw new Error("seed failed");
    const [inbound] = await db
      .insert(messages)
      .values({
        athleteId: a.id,
        direction: "in",
        body: "rest",
        twilioMessageSid: "SM-in-solo",
      })
      .returning();
    if (!inbound) throw new Error("inbound failed");
    const r = await bindReply(a.id, inbound.id, "rest");
    expect(r).toEqual({ resolved: false, reason: "no_open_frames" });
  });

  test("exact match writes resolved_at + resolved_key + back-pointer", async () => {
    const { athlete, frame, inbound } = await seed();
    const r = await bindReply(athlete.id, inbound.id, "rest");
    expect(r.resolved).toBe(true);
    if (!r.resolved) throw new Error("expected resolved");
    expect(r.matchedBy).toBe("exact");
    expect(r.frameId).toBe(frame.id);
    expect(r.key).toBe("rest");

    const [updatedFrame] = await db
      .select()
      .from(pendingDecisions)
      .where(eq(pendingDecisions.id, frame.id));
    expect(updatedFrame?.resolvedAt).not.toBeNull();
    expect(updatedFrame?.resolvedKey).toBe("rest");

    const [updatedInbound] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, inbound.id));
    expect(updatedInbound?.resolvesPendingDecisionId).toBe(frame.id);
  });

  test("falls through to LLM when no exact match — null answer leaves frame open", async () => {
    const { athlete, frame, inbound } = await seed();
    mockProvider.setResponses([
      { match: /.*/, text: '{"key":null,"reasoning":"unrelated"}' },
    ]);
    const r = await bindReply(athlete.id, inbound.id, "what's the weather");
    expect(r).toEqual({ resolved: false, reason: "no_match" });

    const [updated] = await db
      .select()
      .from(pendingDecisions)
      .where(eq(pendingDecisions.id, frame.id));
    expect(updated?.resolvedAt).toBeNull();
  });

  test("LLM resolves an ambiguous reply when it's confident", async () => {
    const { athlete, frame, inbound } = await seed();
    mockProvider.setResponses([
      { match: /.*/, text: '{"key":"rest","reasoning":"skip aligns with rest"}' },
    ]);
    const r = await bindReply(athlete.id, inbound.id, "yeah skip it");
    expect(r.resolved).toBe(true);
    if (!r.resolved) throw new Error("expected resolved");
    expect(r.matchedBy).toBe("llm");
    expect(r.key).toBe("rest");

    const [updated] = await db
      .select()
      .from(pendingDecisions)
      .where(eq(pendingDecisions.id, frame.id));
    expect(updated?.resolvedKey).toBe("rest");
  });

  test("rejects LLM picks that aren't in the frame's option keys (hallucination guard)", async () => {
    const { athlete, frame, inbound } = await seed();
    mockProvider.setResponses([
      { match: /.*/, text: '{"key":"swim","reasoning":"runner wants swim"}' },
    ]);
    const r = await bindReply(athlete.id, inbound.id, "i think i'll swim");
    expect(r).toEqual({ resolved: false, reason: "no_match" });
    const [unchanged] = await db
      .select()
      .from(pendingDecisions)
      .where(eq(pendingDecisions.id, frame.id));
    expect(unchanged?.resolvedAt).toBeNull();
  });

  test("logs a binder telemetry row in llm_calls when LLM stage runs", async () => {
    const { athlete, inbound } = await seed();
    mockProvider.setResponses([
      { match: /.*/, text: '{"key":null,"reasoning":"unrelated"}' },
    ]);
    await bindReply(athlete.id, inbound.id, "what's the weather");
    const calls = await db.select().from(llmCalls);
    const binderCalls = calls.filter((c) => c.component === "binder");
    expect(binderCalls).toHaveLength(1);
    expect(binderCalls[0]?.athleteId).toBe(athlete.id);
    expect(binderCalls[0]?.messageId).toBe(inbound.id);
  });

  test("exact match never burns an LLM call", async () => {
    const { athlete, inbound } = await seed();
    await bindReply(athlete.id, inbound.id, "rest");
    const calls = await db.select().from(llmCalls);
    expect(calls.filter((c) => c.component === "binder")).toHaveLength(0);
  });

  test("walks frames newest-first across multiple open frames", async () => {
    const [a] = await db
      .insert(athletes)
      .values({ phone: "+15551110302", name: "MultiFrame" })
      .returning();
    if (!a) throw new Error("athlete failed");
    const [out] = await db
      .insert(messages)
      .values({
        athleteId: a.id,
        direction: "out",
        body: "q",
        twilioMessageSid: "SM-mf-out",
      })
      .returning();
    if (!out) throw new Error("out failed");

    // Two open frames; both contain a "rest" option.
    const olderFrame = await recordFrame(a.id, out.id, FRAME_TWO_OPTION);
    await new Promise((r) => setTimeout(r, 15));
    const newerFrame = await recordFrame(a.id, out.id, FRAME_THREE_OPTION);

    const [inbound] = await db
      .insert(messages)
      .values({
        athleteId: a.id,
        direction: "in",
        body: "rest",
        twilioMessageSid: "SM-mf-in",
      })
      .returning();
    if (!inbound) throw new Error("inbound failed");

    const r = await bindReply(a.id, inbound.id, "rest");
    expect(r.resolved).toBe(true);
    if (!r.resolved) throw new Error("expected resolved");
    // Newer frame wins.
    expect(r.frameId).toBe(newerFrame.id);

    // Older frame stays open.
    const [olderAfter] = await db
      .select()
      .from(pendingDecisions)
      .where(eq(pendingDecisions.id, olderFrame.id));
    expect(olderAfter?.resolvedAt).toBeNull();
  });
});
