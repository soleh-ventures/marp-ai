import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { athletes } from "../db/schema.js";
import { applyLocationChange, looksLikeTimezoneChange } from "./timezone-override.js";

// The pre-filter is the cost gate: it decides whether we pay for a Haiku
// extraction at all. It should fire on real location announcements and
// stay quiet on ordinary chat — false positives cost one null Haiku call,
// false negatives silently ignore the runner's correction.
describe("looksLikeTimezoneChange", () => {
  const positives = [
    "I live in NYC actually",
    "I'm in Tokyo this week",
    "i am in london right now",
    "I moved to Berlin last month",
    "just relocated to Singapore",
    "I'm based in Sydney",
    "currently in Bali",
    "can you change my timezone to Paris",
    "set timezone to America/Chicago",
    "flying to Dubai tomorrow",
  ];
  for (const msg of positives) {
    test(`fires on: "${msg}"`, () => {
      expect(looksLikeTimezoneChange(msg)).toBe(true);
    });
  }

  const negatives = [
    "I'm in pain after that long run",
    "how many km should I do this week?",
    "thanks, that was helpful",
    "my knee hurts",
    "what's my plan for tomorrow",
  ];
  for (const msg of negatives) {
    test(`stays quiet on: "${msg}"`, () => {
      expect(looksLikeTimezoneChange(msg)).toBe(false);
    });
  }
});

// KER-78 (1a / D2): the DB write path. A permanent MOVE updates the
// home-city SSOT + timezone; a temporary TRIP shifts only the timezone and
// PRESERVES home — this is what stops "where do I live" drifting to a
// travel destination.
describe("applyLocationChange (DB)", () => {
  beforeEach(async () => {
    assertNotProductionDb();
    await db.execute(sql`TRUNCATE TABLE athletes RESTART IDENTITY CASCADE`);
  });

  async function seed(): Promise<string> {
    const [a] = await db
      .insert(athletes)
      .values({ phone: "+15551112222", name: "Mover", timezone: "Europe/Berlin", homeCity: "Berlin" })
      .returning();
    if (!a) throw new Error("insert failed");
    return a.id;
  }

  async function row(id: string) {
    const [r] = await db
      .select({ timezone: athletes.timezone, homeCity: athletes.homeCity, setAt: athletes.homeCitySetAt })
      .from(athletes)
      .where(eq(athletes.id, id))
      .limit(1);
    if (!r) throw new Error("not found");
    return r;
  }

  test("move updates home city + timezone", async () => {
    const id = await seed();
    const reply = await applyLocationChange(id, {
      timezone: "Asia/Tokyo",
      city: "Tokyo",
      kind: "move",
    });
    const r = await row(id);
    expect(r.homeCity).toBe("Tokyo");
    expect(r.timezone).toBe("Asia/Tokyo");
    expect(r.setAt).not.toBeNull();
    expect(reply).toContain("Tokyo");
  });

  test("trip shifts timezone but preserves home city", async () => {
    const id = await seed();
    await applyLocationChange(id, {
      timezone: "Asia/Tokyo",
      city: "Tokyo",
      kind: "trip",
    });
    const r = await row(id);
    expect(r.homeCity).toBe("Berlin"); // unchanged
    expect(r.timezone).toBe("Asia/Tokyo"); // shifted for reminders
  });

  test("move without a city name updates timezone only, leaves home", async () => {
    const id = await seed();
    await applyLocationChange(id, {
      timezone: "America/New_York",
      city: null,
      kind: "move",
    });
    const r = await row(id);
    expect(r.homeCity).toBe("Berlin"); // no city given → don't blank home
    expect(r.timezone).toBe("America/New_York");
  });
});
