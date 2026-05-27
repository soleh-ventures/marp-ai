import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  activeFlags,
  activities,
  athletes,
  messages,
  raceBlocks,
} from "../db/schema.js";
import {
  formatActivityLine,
  formatContext,
  getMemoryContext,
} from "./retrieve.js";

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
    expect(text).not.toContain("Recent training");
  });
});

describe("formatActivityLine", () => {
  test("run with distance, pace, and HR", () => {
    const line = formatActivityLine({
      discipline: "run",
      startedAt: new Date("2026-05-26T06:30:00Z"),
      durationS: 3600,
      metrics: {
        distance_m: 10_000,
        avg_pace_s_per_km: 360,
        avg_hr: 152.4,
      },
      longRun: false,
    });
    expect(line).toContain("2026-05-26");
    expect(line).toContain("run");
    expect(line).toContain("1h00");
    expect(line).toContain("10.0 km");
    expect(line).toContain("6:00/km");
    expect(line).toContain("HR 152");
    expect(line).not.toContain("long");
  });

  test("long run label appears when longRun=true", () => {
    const line = formatActivityLine({
      discipline: "run",
      startedAt: new Date("2026-05-22T07:00:00Z"),
      durationS: 7500,
      metrics: { distance_m: 22_000, avg_pace_s_per_km: 341 },
      longRun: true,
    });
    expect(line).toContain("long run");
    expect(line).toContain("22.0 km");
    expect(line).toContain("5:41/km");
  });

  test("strength session with no distance — omits pace/distance", () => {
    const line = formatActivityLine({
      discipline: "strength",
      startedAt: new Date("2026-05-25T18:00:00Z"),
      durationS: 2700,
      metrics: { distance_m: 0 },
      longRun: false,
    });
    expect(line).toContain("strength");
    expect(line).toContain("0h45");
    expect(line).not.toContain("km");
    expect(line).not.toContain("/km");
  });

  test("handles null / missing metrics object", () => {
    const line = formatActivityLine({
      discipline: "run",
      startedAt: new Date("2026-05-26T06:30:00Z"),
      durationS: 1800,
      metrics: null,
      longRun: false,
    });
    expect(line).toContain("run");
    expect(line).toContain("0h30");
    expect(line).not.toContain("km");
    expect(line).not.toContain("HR");
  });
});

describe("getMemoryContext — activities", () => {
  test("includes recent activities newest-first, capped at 14", async () => {
    const [a] = await db
      .insert(athletes)
      .values({ phone: "+15551110099", name: "Runner" })
      .returning();
    if (!a) throw new Error("insert failed");

    // 20 runs over the last 30 days. Should cap to 14 most-recent.
    const rows: Array<typeof activities.$inferInsert> = [];
    for (let i = 0; i < 20; i += 1) {
      rows.push({
        athleteId: a.id,
        discipline: "run",
        source: "strava",
        sourceId: `s${i}`,
        startedAt: new Date(2026, 4, 27 - i, 6, 30),
        durationS: 3600,
        metrics: { distance_m: 10_000, avg_pace_s_per_km: 360 },
        longRun: false,
      });
    }
    await db.insert(activities).values(rows);

    const ctx = await getMemoryContext(a.id);
    expect(ctx.recentActivityCount).toBe(14);
    expect(ctx.text).toContain("Recent training");
    // Newest entry (i=0 → 2026-05-27) appears before oldest in-window.
    const idxNewest = ctx.text.indexOf("2026-05-27");
    const idxOldestInWindow = ctx.text.indexOf("2026-05-14");
    expect(idxNewest).toBeGreaterThan(-1);
    expect(idxOldestInWindow).toBeGreaterThan(idxNewest);
    // i=14 (2026-05-13) is outside the 14-cap.
    expect(ctx.text).not.toContain("2026-05-13");
  });

  test("no Recent training section when athlete has no activities", async () => {
    const [a] = await db
      .insert(athletes)
      .values({ phone: "+15551110098", name: "NoRuns" })
      .returning();
    if (!a) throw new Error("insert failed");
    const ctx = await getMemoryContext(a.id);
    expect(ctx.recentActivityCount).toBe(0);
    expect(ctx.text).not.toContain("Recent training");
  });
});
