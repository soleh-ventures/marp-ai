import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { assertNotProductionDb } from "../../db/test-guard.js";
import { athletes, safetyEvents } from "../../db/schema.js";
import { recordSafetyEvent } from "./events.js";

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`TRUNCATE TABLE safety_events, athletes RESTART IDENTITY CASCADE`);
});

async function makeAthlete() {
  const [a] = await db
    .insert(athletes)
    .values({ phone: `+15551${Math.floor(Math.random() * 1000000)}` })
    .returning();
  if (!a) throw new Error("insert failed");
  return a.id;
}

describe("recordSafetyEvent (S4)", () => {
  test("writes a row for an emergency, truncating the excerpt", async () => {
    const athleteId = await makeAthlete();
    const long = "chest pain ".repeat(40); // > 280 chars
    await recordSafetyEvent(
      athleteId,
      null,
      { tier: "emergency", category: "cardiac", reason: "chest pain" },
      long,
    );
    const rows = await db
      .select()
      .from(safetyEvents)
      .where(eq(safetyEvents.athleteId, athleteId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tier).toBe("emergency");
    expect(rows[0]?.category).toBe("cardiac");
    expect((rows[0]?.messageExcerpt ?? "").length).toBeLessThanOrEqual(280);
  });

  test("does not write for tier none", async () => {
    const athleteId = await makeAthlete();
    await recordSafetyEvent(athleteId, null, { tier: "none", category: "none", reason: "" }, "hi");
    const rows = await db.select().from(safetyEvents).where(eq(safetyEvents.athleteId, athleteId));
    expect(rows).toHaveLength(0);
  });
});
