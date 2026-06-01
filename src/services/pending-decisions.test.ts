import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { athletes, messages } from "../db/schema.js";
import { getOpenFrames, recordFrame } from "./pending-decisions.js";

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

async function seedAthlete() {
  const [a] = await db
    .insert(athletes)
    .values({ phone: "+15551110200", name: "Frame Tester" })
    .returning();
  if (!a) throw new Error("athlete insert failed");
  return a;
}

async function seedOutbound(athleteId: string, body: string, sid: string) {
  const [m] = await db
    .insert(messages)
    .values({ athleteId, direction: "out", body, twilioMessageSid: sid })
    .returning();
  if (!m) throw new Error("message insert failed");
  return m;
}

const FRAME_A = {
  question: "Rest or easy 5K?",
  options: [
    { key: "rest", label: "Rest" },
    { key: "easy_5k", label: "Easy 5K" },
  ],
};

const FRAME_B = {
  question: "Tempo or swap?",
  options: [
    { key: "tempo", label: "Run the tempo" },
    { key: "easy", label: "Swap to easy" },
  ],
};

describe("recordFrame", () => {
  test("persists with back-pointer to the outbound message", async () => {
    const a = await seedAthlete();
    const out = await seedOutbound(a.id, "Want to rest?", "SM-out-A");
    const row = await recordFrame(a.id, out.id, FRAME_A);
    expect(row.athleteId).toBe(a.id);
    expect(row.messageId).toBe(out.id);
    expect(row.frame).toEqual(FRAME_A);
    expect(row.resolvedAt).toBeNull();
  });

  test("accepts a null messageId (rare — outbound not yet persisted)", async () => {
    const a = await seedAthlete();
    const row = await recordFrame(a.id, null, FRAME_A);
    expect(row.messageId).toBeNull();
  });
});

describe("getOpenFrames", () => {
  test("returns only unresolved frames, newest first", async () => {
    const a = await seedAthlete();
    const out1 = await seedOutbound(a.id, "first", "SM-1");
    const out2 = await seedOutbound(a.id, "second", "SM-2");
    await recordFrame(a.id, out1.id, FRAME_A);
    // Tiny delay so created_at strictly orders.
    await new Promise((r) => setTimeout(r, 10));
    const second = await recordFrame(a.id, out2.id, FRAME_B);

    const open = await getOpenFrames(a.id);
    expect(open).toHaveLength(2);
    expect(open[0]?.id).toBe(second.id); // newest first
    expect(open[0]?.frame).toEqual(FRAME_B);
  });

  test("excludes resolved frames", async () => {
    const a = await seedAthlete();
    const out = await seedOutbound(a.id, "x", "SM-x");
    const r1 = await recordFrame(a.id, out.id, FRAME_A);
    await recordFrame(a.id, out.id, FRAME_B);

    // Mark r1 resolved.
    await db.execute(sql`
      UPDATE pending_decisions
        SET resolved_at = now(), resolved_key = 'rest'
        WHERE id = ${r1.id}
    `);
    const open = await getOpenFrames(a.id);
    expect(open).toHaveLength(1);
    expect(open[0]?.frame).toEqual(FRAME_B);
  });

  test("respects the limit argument", async () => {
    const a = await seedAthlete();
    const out = await seedOutbound(a.id, "x", "SM-x");
    for (let i = 0; i < 3; i++) {
      await recordFrame(a.id, out.id, {
        ...FRAME_A,
        question: `q-${i}`,
      });
    }
    const open = await getOpenFrames(a.id, 2);
    expect(open).toHaveLength(2);
  });

  test("scopes to the athlete — never returns frames for other runners", async () => {
    const a = await seedAthlete();
    const out = await seedOutbound(a.id, "x", "SM-x");
    await recordFrame(a.id, out.id, FRAME_A);

    const [b] = await db
      .insert(athletes)
      .values({ phone: "+15551110201", name: "Other" })
      .returning();
    if (!b) throw new Error("other athlete insert failed");

    const open = await getOpenFrames(b.id);
    expect(open).toEqual([]);
  });
});
