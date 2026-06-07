import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { activities, activityAnalyses, athletes, messages } from "../db/schema.js";
import { _resetProviderCache, mockProvider } from "./llm/index.js";
import { extractRunFeeling, parseFeeling } from "./run-feeling.js";

beforeAll(() => {
  (config.llm as { provider: "mock" | "anthropic" }).provider = "mock";
  _resetProviderCache();
});

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`
    TRUNCATE TABLE
      plan_adjustments, activity_analyses,
      llm_calls, processed_messages, messages, active_flags,
      activities, race_blocks, strava_connections,
      pending_decisions, athletes
    RESTART IDENTITY CASCADE
  `);
  mockProvider.reset();
});

describe("parseFeeling (pure)", () => {
  test("parses a full feeling and keeps verbatim", () => {
    const raw = JSON.stringify({
      feeling: {
        effort: { rpe: 7, band: "hard" },
        energy: "depleted",
        pain: { present: true, location: "knee", severity: 3 },
        adherence: "cut_short",
        context: "slept badly",
      },
    });
    const f = parseFeeling(raw, "legs dead, 7, knee twinge, cut short");
    expect(f).not.toBeNull();
    expect(f!.effort).toEqual({ rpe: 7, band: "hard" });
    expect(f!.energy).toBe("depleted");
    expect(f!.pain).toEqual({ present: true, location: "knee", severity: 3 });
    expect(f!.adherence).toBe("cut_short");
    expect(f!.verbatim).toContain("knee twinge");
  });

  test("feeling: null → null (no signal)", () => {
    expect(parseFeeling('{"feeling": null}', "what's tomorrow?")).toBeNull();
  });

  test("non-JSON → null", () => {
    expect(parseFeeling("no json here", "hi")).toBeNull();
  });

  test("coerces unknown enums + out-of-range rpe to safe defaults", () => {
    const raw = JSON.stringify({
      feeling: {
        effort: { rpe: 99, band: "spicy" },
        energy: "ecstatic",
        pain: {},
        adherence: "vibes",
      },
    });
    const f = parseFeeling(raw, "ran")!;
    expect(f.effort.rpe).toBeNull(); // 99 out of range
    expect(f.effort.band).toBe("unknown");
    expect(f.energy).toBe("unknown");
    expect(f.adherence).toBe("unknown");
    expect(f.pain.present).toBe(false);
  });
});

async function seedAthleteAndRun(opts: { hoursAgo: number; sourceId: string }) {
  const [a] = await db
    .insert(athletes)
    .values({ phone: `+155515${Math.floor(Math.random() * 100000)}`, name: "Runner" })
    .returning();
  if (!a) throw new Error("athlete insert failed");
  const [act] = await db
    .insert(activities)
    .values({
      athleteId: a.id,
      discipline: "run",
      source: "strava",
      sourceId: opts.sourceId,
      startedAt: new Date(Date.now() - opts.hoursAgo * 60 * 60 * 1000),
      durationS: 1800,
      metrics: { distance_m: 6000 },
    })
    .returning();
  if (!act) throw new Error("activity insert failed");
  // A real inbound message — llm_calls.message_id is a uuid FK, so the
  // extractor's messageId must be a genuine message id (as in production).
  const [m] = await db
    .insert(messages)
    .values({ athleteId: a.id, direction: "in", body: "check-in reply" })
    .returning({ id: messages.id });
  if (!m) throw new Error("message insert failed");
  return { athleteId: a.id, activityId: act.id, messageId: m.id };
}

describe("extractRunFeeling (DB + mock LLM)", () => {
  test("empty body → not captured, no LLM", async () => {
    const { athleteId, messageId } = await seedAthleteAndRun({ hoursAgo: 1, sourceId: "f0" });
    const r = await extractRunFeeling({ athleteId, messageId, body: "  " });
    expect(r).toEqual({ captured: false, reason: "empty" });
    expect(mockProvider.calls).toHaveLength(0);
  });

  test("no run in the window → not captured, no LLM (cost guard)", async () => {
    const { athleteId, messageId } = await seedAthleteAndRun({ hoursAgo: 72, sourceId: "f1" });
    const r = await extractRunFeeling({ athleteId, messageId, body: "legs felt great" });
    expect(r).toEqual({ captured: false, reason: "no_recent_run" });
    expect(mockProvider.calls).toHaveLength(0);
  });

  test("recent run + feeling message → captured + stored", async () => {
    const { athleteId, activityId, messageId } = await seedAthleteAndRun({ hoursAgo: 1, sourceId: "f2" });
    mockProvider.setResponses([
      {
        match: "legs were dead",
        text: JSON.stringify({
          feeling: {
            effort: { rpe: 7, band: "hard" },
            energy: "depleted",
            pain: { present: false, location: null, severity: null },
            adherence: "cut_short",
            context: null,
          },
        }),
      },
    ]);
    const r = await extractRunFeeling({
      athleteId,
      messageId,
      body: "legs were dead, maybe a 7, cut it 2k short",
    });
    expect(r.captured).toBe(true);
    const [row] = await db
      .select()
      .from(activityAnalyses)
      .where(eq(activityAnalyses.activityId, activityId));
    const feeling = row?.feeling as { effort?: { rpe?: number }; verbatim?: string };
    expect(feeling?.effort?.rpe).toBe(7);
    expect(feeling?.verbatim).toContain("cut it 2k short");
  });

  test("non-feeling message → no_feeling_signal, nothing stored", async () => {
    const { athleteId, activityId, messageId } = await seedAthleteAndRun({ hoursAgo: 1, sourceId: "f3" });
    mockProvider.setResponses([{ match: "tomorrow", text: '{"feeling": null}' }]);
    const r = await extractRunFeeling({ athleteId, messageId, body: "what's on for tomorrow?" });
    expect(r).toEqual({ captured: false, reason: "no_feeling_signal" });
    const rows = await db
      .select()
      .from(activityAnalyses)
      .where(eq(activityAnalyses.activityId, activityId));
    expect(rows).toHaveLength(0);
  });

  test("coexists with an existing objective row (analysis landed first)", async () => {
    const { athleteId, activityId, messageId } = await seedAthleteAndRun({ hoursAgo: 1, sourceId: "f4" });
    const objective = { source: "splits", split_pattern: "even" };
    await db.insert(activityAnalyses).values({ athleteId, activityId, objective, coachRead: "Clean run." });
    mockProvider.setResponses([
      {
        match: "felt easy",
        text: JSON.stringify({
          feeling: {
            effort: { rpe: null, band: "easy" },
            energy: "positive",
            pain: { present: false, location: null, severity: null },
            adherence: "as_planned",
            context: null,
          },
        }),
      },
    ]);
    await extractRunFeeling({ athleteId, messageId, body: "felt easy and smooth" });
    const [row] = await db
      .select()
      .from(activityAnalyses)
      .where(eq(activityAnalyses.activityId, activityId));
    expect((row?.objective as { split_pattern?: string })?.split_pattern).toBe("even"); // preserved
    expect(row?.coachRead).toBe("Clean run."); // preserved
    expect((row?.feeling as { effort?: { band?: string } })?.effort?.band).toBe("easy"); // added
  });
});
