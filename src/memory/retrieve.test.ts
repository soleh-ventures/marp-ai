import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  activeFlags,
  athletes,
  messages,
  raceBlocks,
} from "../db/schema.js";
import { formatContext, getMemoryContext } from "./retrieve.js";

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      llm_calls, processed_messages, messages, active_flags,
      activities, race_blocks, athletes
    RESTART IDENTITY CASCADE
  `);
});

describe("getMemoryContext", () => {
  test("unknown athlete returns empty context", async () => {
    const ctx = await getMemoryContext("00000000-0000-0000-0000-000000000000");
    expect(ctx.text).toBe("");
    expect(ctx.athleteName).toBeNull();
    expect(ctx.activeFlagCount).toBe(0);
    expect(ctx.recentMessageCount).toBe(0);
  });

  test("known athlete with no flags / no messages renders just the profile", async () => {
    const [a] = await db
      .insert(athletes)
      .values({
        phone: "+15551110001",
        name: "Sarah",
        locale: "en-US",
        athleticHistory: { years_running: 4, prior_races: ["half 1:52"] },
      })
      .returning();
    if (!a) throw new Error("insert failed");
    const ctx = await getMemoryContext(a.id);
    expect(ctx.athleteName).toBe("Sarah");
    expect(ctx.text).toContain("Sarah");
    expect(ctx.text).toContain("en-US");
    expect(ctx.text).toContain("years_running");
    expect(ctx.activeFlagCount).toBe(0);
    expect(ctx.recentMessageCount).toBe(0);
  });

  test("includes only UNRESOLVED active flags", async () => {
    const [a] = await db
      .insert(athletes)
      .values({ phone: "+15551110002", name: "Test" })
      .returning();
    if (!a) throw new Error("insert failed");
    await db.insert(activeFlags).values([
      { athleteId: a.id, kind: "injury", body: "left achilles tight" },
      {
        athleteId: a.id,
        kind: "illness",
        body: "had a cold",
        resolvedAt: new Date(),
      },
    ]);
    const ctx = await getMemoryContext(a.id);
    expect(ctx.activeFlagCount).toBe(1);
    expect(ctx.text).toContain("left achilles tight");
    expect(ctx.text).not.toContain("had a cold");
  });

  test("includes ACTIVE race block with days-to-race math", async () => {
    const [a] = await db
      .insert(athletes)
      .values({ phone: "+15551110003" })
      .returning();
    if (!a) throw new Error("insert failed");
    // 60 days out
    const date = new Date(Date.now() + 60 * 86400 * 1000);
    await db.insert(raceBlocks).values({
      athleteId: a.id,
      raceName: "Jakarta Marathon",
      raceDate: date,
      raceDistance: "marathon",
      goalFinishTime: "4:00:00",
      state: "active",
    });
    const ctx = await getMemoryContext(a.id);
    expect(ctx.text).toContain("Jakarta Marathon");
    expect(ctx.text).toContain("marathon");
    expect(ctx.text).toContain("4:00:00");
    expect(ctx.text).toMatch(/6\d days away/);
  });

  test("renders recent messages oldest-first, capped at 20", async () => {
    const [a] = await db
      .insert(athletes)
      .values({ phone: "+15551110004" })
      .returning();
    if (!a) throw new Error("insert failed");
    // 25 messages, alternating direction. Most recent should win the 20-cap.
    const rows = [];
    for (let i = 0; i < 25; i += 1) {
      rows.push({
        athleteId: a.id,
        direction: (i % 2 === 0 ? "in" : "out") as "in" | "out",
        body: `msg-${i.toString().padStart(2, "0")}`,
        // staggered timestamps so order is stable
        receivedAt: new Date(2026, 0, 1, 0, i, 0),
      });
    }
    await db.insert(messages).values(rows);
    const ctx = await getMemoryContext(a.id);
    expect(ctx.recentMessageCount).toBe(20);
    // Most recent 20 are msg-05 through msg-24, rendered oldest-first.
    const idx05 = ctx.text.indexOf("msg-05");
    const idx24 = ctx.text.indexOf("msg-24");
    expect(idx05).toBeGreaterThan(-1);
    expect(idx24).toBeGreaterThan(idx05);
    // msg-04 falls outside the cap.
    expect(ctx.text).not.toContain("msg-04");
  });
});

describe("formatContext", () => {
  test("omits empty sections", () => {
    const text = formatContext({
      name: "Test",
      locale: "en",
      athleticHistory: null,
      flags: [],
      block: undefined,
      messages: [],
    });
    expect(text).toContain("Athlete: Test");
    expect(text).not.toContain("Active flags");
    expect(text).not.toContain("Recent conversation");
    expect(text).not.toContain("Active race block");
  });
});
