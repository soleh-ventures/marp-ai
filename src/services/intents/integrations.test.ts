// Garmin intent — the founder (whose watch data flows via the recovery
// sidecar) must never be told they're "on the waitlist". Everyone else is.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { assertNotProductionDb } from "../../db/test-guard.js";
import { athletes, garminWellness } from "../../db/schema.js";
import { getAthleticHistory } from "../../flows/onboarding.js";
import {
  GARMIN_ALREADY_CONNECTED_REPLY,
  GARMIN_WAITLIST_REPLY,
  recordGarminInterest,
} from "./integrations.js";

assertNotProductionDb();

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE garmin_wellness, athletes RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE TABLE garmin_wellness, athletes RESTART IDENTITY CASCADE`);
});

async function makeAthlete(history: Record<string, unknown> = {}): Promise<string> {
  const [a] = await db
    .insert(athletes)
    .values({ phone: "+15550002222", consentGrantedAt: new Date(), athleticHistory: history })
    .returning({ id: athletes.id });
  return a!.id;
}

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
}

describe("recordGarminInterest", () => {
  it("tells an athlete with recent wellness data they're already connected", async () => {
    const id = await makeAthlete();
    await db.insert(garminWellness).values({ athleteId: id, date: isoDaysAgo(1), readinessScore: 72 });
    const reply = await recordGarminInterest(id);
    expect(reply).toBe(GARMIN_ALREADY_CONNECTED_REPLY);
  });

  it("self-heals a stale waitlist flag once data is flowing", async () => {
    const id = await makeAthlete({ garmin_waitlist_at: "2026-07-05T00:00:00.000Z" });
    await db.insert(garminWellness).values({ athleteId: id, date: isoDaysAgo(2), readinessScore: 65 });
    const reply = await recordGarminInterest(id);
    expect(reply).toBe(GARMIN_ALREADY_CONNECTED_REPLY);
    const [row] = await db
      .select({ athleticHistory: athletes.athleticHistory })
      .from(athletes)
      .where(eq(athletes.id, id));
    expect(getAthleticHistory(row!.athleticHistory).garmin_waitlist_at).toBeUndefined();
  });

  it("waitlists an athlete with no Garmin data (and stamps the signal)", async () => {
    const id = await makeAthlete();
    const reply = await recordGarminInterest(id);
    expect(reply).toBe(GARMIN_WAITLIST_REPLY);
    const [row] = await db
      .select({ athleticHistory: athletes.athleticHistory })
      .from(athletes)
      .where(eq(athletes.id, id));
    expect(getAthleticHistory(row!.athleticHistory).garmin_waitlist_at).toBeTypeOf("string");
  });

  it("does NOT count stale (>21d) wellness data as connected", async () => {
    const id = await makeAthlete();
    await db.insert(garminWellness).values({ athleteId: id, date: isoDaysAgo(40), readinessScore: 70 });
    const reply = await recordGarminInterest(id);
    expect(reply).toBe(GARMIN_WAITLIST_REPLY);
  });
});
