import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "./client.js";
import { assertNotProductionDb } from "./test-guard.js";
import {
  athletes,
  messages,
  pendingDecisions,
} from "./schema.js";

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`
    TRUNCATE TABLE
      llm_calls, processed_messages, messages, active_flags,
      activities, race_blocks, strava_connections,
      pending_decisions, athletes
    RESTART IDENTITY CASCADE
  `);
});

async function seedAthleteWithOutbound() {
  const [a] = await db
    .insert(athletes)
    .values({ phone: "+15551110100", name: "Binder Tester" })
    .returning();
  if (!a) throw new Error("athlete insert failed");
  const [m] = await db
    .insert(messages)
    .values({
      athleteId: a.id,
      direction: "out",
      body: "Want to rest today, or do an easy 5K?",
      twilioMessageSid: "SM-out-1",
    })
    .returning();
  if (!m) throw new Error("message insert failed");
  return { athlete: a, outbound: m };
}

const SAMPLE_FRAME = {
  question: "Rest or easy 5K?",
  options: [
    { key: "rest", label: "Rest day" },
    { key: "easy_5k", label: "Easy 5K", action_hint: "Conversational pace" },
  ],
};

describe("pending_decisions schema (ET8)", () => {
  test("inserts a frame with the expected jsonb shape", async () => {
    const { athlete, outbound } = await seedAthleteWithOutbound();
    const [row] = await db
      .insert(pendingDecisions)
      .values({
        athleteId: athlete.id,
        messageId: outbound.id,
        frame: SAMPLE_FRAME,
      })
      .returning();
    expect(row?.frame).toEqual(SAMPLE_FRAME);
    expect(row?.resolvedAt).toBeNull();
    expect(row?.resolvedKey).toBeNull();
  });

  test("cascades to pending_decisions on athlete delete", async () => {
    const { athlete, outbound } = await seedAthleteWithOutbound();
    await db.insert(pendingDecisions).values({
      athleteId: athlete.id,
      messageId: outbound.id,
      frame: SAMPLE_FRAME,
    });
    await db.delete(athletes).where(eq(athletes.id, athlete.id));
    expect(
      await db
        .select()
        .from(pendingDecisions)
        .where(eq(pendingDecisions.athleteId, athlete.id)),
    ).toEqual([]);
  });

  test("SET NULL on the outbound message delete — frame survives", async () => {
    const { athlete, outbound } = await seedAthleteWithOutbound();
    await db.insert(pendingDecisions).values({
      athleteId: athlete.id,
      messageId: outbound.id,
      frame: SAMPLE_FRAME,
    });
    await db.delete(messages).where(eq(messages.id, outbound.id));
    const surviving = await db
      .select()
      .from(pendingDecisions)
      .where(eq(pendingDecisions.athleteId, athlete.id));
    expect(surviving).toHaveLength(1);
    expect(surviving[0]?.messageId).toBeNull();
    expect(surviving[0]?.frame).toEqual(SAMPLE_FRAME);
  });

  test("messages.resolves_pending_decision_id SET NULL on decision delete", async () => {
    const { athlete, outbound } = await seedAthleteWithOutbound();
    const [decision] = await db
      .insert(pendingDecisions)
      .values({
        athleteId: athlete.id,
        messageId: outbound.id,
        frame: SAMPLE_FRAME,
      })
      .returning();
    if (!decision) throw new Error("decision insert failed");

    // Inbound message that resolved it.
    const [inbound] = await db
      .insert(messages)
      .values({
        athleteId: athlete.id,
        direction: "in",
        body: "rest",
        twilioMessageSid: "SM-in-1",
        resolvesPendingDecisionId: decision.id,
      })
      .returning();
    if (!inbound) throw new Error("inbound insert failed");
    expect(inbound.resolvesPendingDecisionId).toBe(decision.id);

    await db.delete(pendingDecisions).where(eq(pendingDecisions.id, decision.id));
    const after = await db
      .select()
      .from(messages)
      .where(eq(messages.id, inbound.id));
    expect(after[0]?.resolvesPendingDecisionId).toBeNull();
  });

  test("partial unresolved-index query is satisfied (smoke check)", async () => {
    const { athlete, outbound } = await seedAthleteWithOutbound();
    // Seed two frames — one resolved, one open. The partial index lives
    // under the WHERE resolved_at IS NULL predicate; selecting on that
    // exact predicate should return only the open one.
    const [open] = await db
      .insert(pendingDecisions)
      .values({
        athleteId: athlete.id,
        messageId: outbound.id,
        frame: SAMPLE_FRAME,
      })
      .returning();
    await db.insert(pendingDecisions).values({
      athleteId: athlete.id,
      messageId: outbound.id,
      frame: { ...SAMPLE_FRAME, question: "Already answered" },
      resolvedAt: new Date(),
      resolvedKey: "rest",
    });
    const openOnly = await db
      .select()
      .from(pendingDecisions)
      .where(
        sql`${pendingDecisions.athleteId} = ${athlete.id} AND ${pendingDecisions.resolvedAt} IS NULL`,
      );
    expect(openOnly).toHaveLength(1);
    expect(openOnly[0]?.id).toBe(open?.id ?? "");
  });
});
