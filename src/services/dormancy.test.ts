import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { athletes } from "../db/schema.js";
import {
  DORMANCY_THRESHOLD_DAYS,
  archiveAthlete,
  isDormant,
  touchLastSeen,
} from "./dormancy.js";
import { findOrCreateByPhone } from "./athletes.js";

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`
    TRUNCATE TABLE
      llm_calls, processed_messages, messages, active_flags,
      activities, race_blocks, strava_connections, athletes
    RESTART IDENTITY CASCADE
  `);
});

describe("isDormant", () => {
  test("false for a fresh row", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    expect(isDormant(new Date("2026-05-01T00:00:00Z"), now)).toBe(false);
  });

  test("false at exactly the threshold (strictly greater-than)", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const exactly = new Date(now.getTime() - DORMANCY_THRESHOLD_DAYS * 86400 * 1000);
    expect(isDormant(exactly, now)).toBe(false);
  });

  test("true just past the threshold", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const justPast = new Date(
      now.getTime() - DORMANCY_THRESHOLD_DAYS * 86400 * 1000 - 1000,
    );
    expect(isDormant(justPast, now)).toBe(true);
  });
});

describe("touchLastSeen", () => {
  test("updates the athlete's last_seen_at to now", async () => {
    const [a] = await db
      .insert(athletes)
      .values({
        phone: "+15551110001",
        lastSeenAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning();
    if (!a) throw new Error("insert failed");
    await touchLastSeen(a.id);
    const [after] = await db
      .select()
      .from(athletes)
      .where(eq(athletes.id, a.id));
    if (!after) throw new Error("read failed");
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(
      new Date("2026-01-01T00:00:00Z").getTime(),
    );
  });
});

describe("archiveAthlete + findOrCreateByPhone interaction", () => {
  test("archived row stops shadowing the phone — next lookup creates a fresh row", async () => {
    const phone = "+15551110002";
    const first = await findOrCreateByPhone(phone);
    await archiveAthlete(first.id);

    const second = await findOrCreateByPhone(phone);
    expect(second.id).not.toBe(first.id);

    // Both rows survive; only the new one is "active."
    const rows = await db.select().from(athletes);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.archivedAt !== null)).toHaveLength(1);
    expect(rows.filter((r) => r.archivedAt === null)).toHaveLength(1);
  });

  test("findOrCreateByPhone does NOT return an archived row", async () => {
    const phone = "+15551110003";
    const original = await findOrCreateByPhone(phone);
    await archiveAthlete(original.id);
    const second = await findOrCreateByPhone(phone);
    expect(second.id).not.toBe(original.id);
    expect(second.archivedAt).toBeNull();
  });
});
