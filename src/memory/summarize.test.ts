import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import {
  activeFlags,
  activities,
  athletes,
  llmCalls,
  messages,
  raceBlocks,
} from "../db/schema.js";
import { _resetProviderCache, mockProvider } from "../services/llm/index.js";
import {
  _resetSummarizerPromptCache,
  autoTransitionStaleBlocks,
  buildSummarizerPayload,
  summarizeBlock,
} from "./summarize.js";

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
  _resetSummarizerPromptCache();
});

// ── Pure unit tests ──────────────────────────────────────────────────────

describe("buildSummarizerPayload", () => {
  test("renders the race block header + all sections in order", () => {
    const payload = buildSummarizerPayload({
      block: {
        id: "00000000-0000-0000-0000-000000000000",
        athleteId: "00000000-0000-0000-0000-000000000001",
        raceName: "Jakarta Marathon",
        raceDate: new Date("2026-03-15T00:00:00Z"),
        raceDistance: "marathon",
        goalFinishTime: "4:00:00",
        state: "active",
        plan: null,
        summary: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      athleteName: "Sarah",
      activities: [
        {
          discipline: "run",
          startedAt: new Date("2026-02-01T06:00:00Z"),
          durationS: 3600,
          metrics: { distance_m: 10000, avg_pace_s_per_km: 360, avg_hr: 152 },
          longRun: false,
        },
      ],
      flags: [
        {
          kind: "injury",
          body: "left achilles tight",
          startedAt: new Date("2026-02-10T00:00:00Z"),
          resolvedAt: null,
        },
      ],
      messages: [
        {
          direction: "in",
          body: "feeling tired today",
          receivedAt: new Date("2026-02-12T08:00:00Z"),
        },
        {
          direction: "out",
          body: "easy day then",
          receivedAt: new Date("2026-02-12T08:05:00Z"),
        },
      ],
    });
    expect(payload).toContain("Jakarta Marathon");
    expect(payload).toContain("4:00:00");
    expect(payload).toContain("Sarah");
    expect(payload).toContain("10.0km");
    expect(payload).toContain("HR 152");
    expect(payload).toContain("achilles tight");
    expect(payload).toContain("RUNNER: feeling tired");
    expect(payload).toContain("MARP: easy day then");
    // Section ordering — block, then activities, then flags, then conversation.
    const idxBlock = payload.indexOf("# Race block");
    const idxActivities = payload.indexOf("# Activities");
    const idxFlags = payload.indexOf("# Flags during block");
    const idxConv = payload.indexOf("# Conversation");
    expect(idxBlock).toBeLessThan(idxActivities);
    expect(idxActivities).toBeLessThan(idxFlags);
    expect(idxFlags).toBeLessThan(idxConv);
  });

  test("omits the activities-section detail when none are recorded", () => {
    const payload = buildSummarizerPayload({
      block: {
        id: "00000000-0000-0000-0000-000000000000",
        athleteId: "00000000-0000-0000-0000-000000000001",
        raceName: "Some Race",
        raceDate: new Date("2026-03-15"),
        raceDistance: "10k",
        goalFinishTime: null,
        state: "completed",
        plan: null,
        summary: null,
        createdAt: new Date(),
      },
      athleteName: null,
      activities: [],
      flags: [],
      messages: [],
    });
    expect(payload).toContain("none recorded in window");
    expect(payload).toContain("Goal: not set");
    // Empty sections beyond activities are omitted entirely.
    expect(payload).not.toContain("# Flags during block");
    expect(payload).not.toContain("# Conversation");
  });
});

// ── Integration: summarizeBlock against DB + mock provider ──────────────

async function seedFullyPopulatedBlock(overrides: {
  state?: "active" | "completed" | "pending";
  summary?: string | null;
  raceDate?: Date;
} = {}) {
  const [a] = await db
    .insert(athletes)
    .values({ phone: "+15551110500", name: "T8 Tester" })
    .returning();
  if (!a) throw new Error("athlete failed");
  const [block] = await db
    .insert(raceBlocks)
    .values({
      athleteId: a.id,
      raceName: "Test Race",
      raceDate: overrides.raceDate ?? new Date("2026-04-15T00:00:00Z"),
      raceDistance: "marathon",
      goalFinishTime: "3:45:00",
      state: overrides.state ?? "active",
      summary: overrides.summary ?? null,
    })
    .returning();
  if (!block) throw new Error("block failed");
  // One activity inside the window.
  await db.insert(activities).values({
    athleteId: a.id,
    discipline: "run",
    source: "strava",
    sourceId: "s-summarizer-1",
    startedAt: new Date("2026-03-01T06:00:00Z"),
    durationS: 5400,
    metrics: { distance_m: 18000, avg_pace_s_per_km: 300, avg_hr: 148 },
    longRun: true,
  });
  // One flag opened mid-block.
  await db.insert(activeFlags).values({
    athleteId: a.id,
    kind: "injury",
    body: "left achilles tight",
    startedAt: new Date("2026-03-05T00:00:00Z"),
  });
  // A few messages during the window.
  await db.insert(messages).values({
    athleteId: a.id,
    direction: "in",
    body: "did a 18k long today felt great",
    twilioMessageSid: "SM-summ-in-1",
    receivedAt: new Date("2026-03-01T12:00:00Z"),
  });
  return { athlete: a, block };
}

describe("summarizeBlock", () => {
  test("happy path: pulls window content + writes the LLM's summary + transitions to completed", async () => {
    const { block } = await seedFullyPopulatedBlock();
    const generated =
      "Sarah ran 18 km long with HR 148 during a Jakarta marathon build. Achilles tightness flagged early March stayed open through race day. Solid base, conservative approach worked. Next cycle: stretch the long-run window earlier.";
    mockProvider.setResponses([{ match: /.*/, text: generated }]);

    const r = await summarizeBlock(block.id);
    expect(r.written).toBe(true);
    expect(r.summaryLength).toBeGreaterThan(50);

    const [updated] = await db
      .select()
      .from(raceBlocks)
      .where(eq(raceBlocks.id, block.id));
    expect(updated?.summary).toBe(generated);
    expect(updated?.state).toBe("completed");
  });

  test("idempotent: re-running an already-summarized block is a no-op", async () => {
    const existing = "Prior summary lives here.";
    const { block } = await seedFullyPopulatedBlock({
      state: "completed",
      summary: existing,
    });
    const r = await summarizeBlock(block.id);
    expect(r.written).toBe(false);
    expect(r.summaryLength).toBe(existing.length);
    // No LLM call.
    expect(mockProvider.calls).toHaveLength(0);
  });

  test("records llm_calls telemetry under component=memory", async () => {
    const { athlete, block } = await seedFullyPopulatedBlock();
    mockProvider.setResponses([{ match: /.*/, text: "A summary." }]);
    await summarizeBlock(block.id);
    const calls = await db.select().from(llmCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.component).toBe("memory");
    expect(calls[0]?.athleteId).toBe(athlete.id);
  });

  test("empty LLM output → does not write a blank summary (degrades honestly)", async () => {
    const { block } = await seedFullyPopulatedBlock();
    mockProvider.setResponses([{ match: /.*/, text: "   " }]);
    const r = await summarizeBlock(block.id);
    expect(r.written).toBe(false);
    const [unchanged] = await db
      .select()
      .from(raceBlocks)
      .where(eq(raceBlocks.id, block.id));
    expect(unchanged?.summary).toBeNull();
    expect(unchanged?.state).toBe("active"); // not transitioned either
  });

  test("throws on unknown block id", async () => {
    expect(
      summarizeBlock("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow("race_block");
  });
});

describe("autoTransitionStaleBlocks", () => {
  test("identifies active blocks whose race_date is past the grace period", async () => {
    const past = new Date(Date.now() - 30 * 86400_000);
    const { athlete, block } = await seedFullyPopulatedBlock({
      raceDate: past,
    });
    mockProvider.setResponses([{ match: /.*/, text: "stale block summary" }]);
    const r = await autoTransitionStaleBlocks(athlete.id);
    expect(r.transitioned).toContain(block.id);
  });

  test("leaves recent active blocks alone (race still upcoming)", async () => {
    const upcoming = new Date(Date.now() + 30 * 86400_000);
    const { athlete } = await seedFullyPopulatedBlock({ raceDate: upcoming });
    const r = await autoTransitionStaleBlocks(athlete.id);
    expect(r.transitioned).toEqual([]);
    expect(mockProvider.calls).toHaveLength(0);
  });

  test("leaves already-completed blocks alone", async () => {
    const past = new Date(Date.now() - 100 * 86400_000);
    const { athlete } = await seedFullyPopulatedBlock({
      state: "completed",
      summary: "already done",
      raceDate: past,
    });
    const r = await autoTransitionStaleBlocks(athlete.id);
    expect(r.transitioned).toEqual([]);
    expect(mockProvider.calls).toHaveLength(0);
  });
});
