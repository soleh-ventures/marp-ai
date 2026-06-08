#!/usr/bin/env bun
/**
 * Grounded Coach dogfood simulation (dev-only).
 *
 * Seeds a realistic week for a Berlin marathoner — a short long run, a missed
 * tempo, an extra easy run, with stream summaries + run feelings — then runs
 * the REAL coaching code against it (live LLM) so we can read what MARP
 * actually says before a real dogfood week: the coaching context the LLM sees,
 * the deterministic profile readback, and the holistic weekly evaluation +
 * its auto-apply decision.
 *
 * Local DB only (guarded). Usage:
 *   DATABASE_URL=postgresql://localhost:5432/marp_ai_test bun run src/scripts/dogfood-sim.ts
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { activities, activityAnalyses, activityStreams, athletes } from "../db/schema.js";
import { getMemoryContext } from "../memory/retrieve.js";
import { buildProfileReadback, profileQuestionKind } from "../services/profile-readback.js";
import { buildWeeklyEvaluation } from "../services/weekly-evaluation.js";
import type { Plan } from "../services/plan/types.js";
import type { StreamSummary } from "../services/strava-streams.js";

function plan(): Plan {
  const wk = (index: number, longKm: number) => ({
    index,
    phase: (index <= 8 ? "build" : "peak") as "build" | "peak",
    total_km: 45 + index * 2,
    focus: index === 1 ? "settle into the block" : "build aerobic volume",
    sessions: [
      { day_of_week: "monday" as const, type: "easy" as const, distance_km: 8, description: "Easy 8k, conversational" },
      { day_of_week: "wednesday" as const, type: "tempo" as const, distance_km: 10, description: "10k w/ 6k @ threshold" },
      { day_of_week: "friday" as const, type: "easy" as const, distance_km: 6, description: "Easy 6k shakeout" },
      { day_of_week: "saturday" as const, type: "rest" as const, description: "Rest" },
      { day_of_week: "sunday" as const, type: "long" as const, distance_km: longKm, description: `Long ${longKm}k easy` },
    ],
  });
  return {
    version: 1,
    source: "generated",
    start_date: "2026-06-01", // Monday; week 1 = Jun 1–7 (just finished)
    race_date: "2026-09-27",
    race_name: "Berlin Marathon",
    methodology: "Pfitzinger base→build→peak→taper, 80/20 polarized",
    weeks: [wk(1, 20), wk(2, 22), wk(3, 24)],
    generated_at: "2026-05-30T00:00:00Z",
  };
}

function run(dateISO: string, km: number, durMin: number) {
  return {
    discipline: "run",
    source: "strava" as const,
    sourceId: `sim-${dateISO}`,
    startedAt: new Date(`${dateISO}T07:00:00Z`),
    durationS: durMin * 60,
    metrics: { distance_m: km * 1000, avg_pace_s_per_km: Math.round((durMin * 60) / km), avg_hr: 150 },
    rawPayload: { name: `${km}k run` },
    longRun: km >= 18,
  };
}

const positiveSplitSummary: StreamSummary = {
  km_splits: Array.from({ length: 14 }, (_, i) => ({ km: i + 1, pace_s_per_km: 330 + i * 4, avg_hr: 150 + i })),
  split_pattern: "positive",
  hr_drift_pct: 8.2,
  avg_hr: 158,
  max_hr: 172,
  total_distance_m: 14000,
  total_time_s: 14 * 350,
};

async function main(): Promise<void> {
  assertNotProductionDb();
  await db.execute(sql`TRUNCATE TABLE activity_streams, activity_analyses, activities, weekly_evaluations, athletes RESTART IDENTITY CASCADE`);

  const [a] = await db
    .insert(athletes)
    .values({
      phone: "+4915550001111",
      name: "Kemal",
      timezone: "Europe/Berlin",
      homeCity: "Berlin",
      athleticHistory: {
        age: 34,
        experience: "intermediate",
        target_race: { name: "Berlin Marathon", distance: "marathon", goal_time: "4:30:00", date: "2026-09-27" },
        plan: plan(),
      },
    })
    .returning();
  if (!a) throw new Error("seed failed");

  // Week 1 (Jun 1–7) actuals: easy done, tempo MISSED, easy done, long SHORT
  // (14k of 20k), plus an unplanned Thursday 5k.
  const acts = [
    run("2026-06-01", 8, 44), // Mon easy → done
    run("2026-06-04", 5, 28), // Thu — extra (unplanned)
    run("2026-06-05", 6, 33), // Fri easy → done
    run("2026-06-07", 14, 82), // Sun long → SHORT (prescribed 20k), positive split, HR drift
  ];
  const inserted = await db.insert(activities).values(acts.map((x) => ({ ...x, athleteId: a.id }))).returning({ id: activities.id, sourceId: activities.sourceId });
  const longRow = inserted.find((r) => r.sourceId === "sim-2026-06-07");
  if (longRow) await db.insert(activityStreams).values({ activityId: longRow.id, summary: positiveSplitSummary });

  // Run feelings (drive week signals): the long run felt hard + low energy.
  await db.insert(activityAnalyses).values([
    { athleteId: a.id, activityId: longRow!.id, objective: { hr_drift_pct: 8.2, split_pattern: "positive" }, feeling: { effort: { rpe: 9, band: "hard" }, energy: "low", adherence: "cut_short", pain: { present: false } }, coachRead: null },
  ]);

  const line = "─".repeat(72);
  console.log(`\n${line}\n1) COACHING CONTEXT — what the LLM actually receives\n${line}`);
  const ctx = await getMemoryContext(a.id);
  console.log(ctx.text);

  console.log(`\n${line}\n2) DETERMINISTIC PROFILE READBACK (no LLM)\n${line}`);
  for (const q of ["where do I live?", "what's my goal?"]) {
    const kind = profileQuestionKind(q);
    const ans = kind ? await buildProfileReadback(a.id, kind) : null;
    console.log(`Q: ${q}\nA: ${ans}\n`);
  }

  console.log(`\n${line}\n3) WEEKLY EVALUATION — the coach's read (LIVE LLM)\n${line}`);
  const ev = await buildWeeklyEvaluation(a.id);
  if (!ev) {
    console.log("(no evaluation — no plan?)");
  } else {
    console.log(`MESSAGE:\n${ev.message}\n`);
    console.log(`DECISION: ${JSON.stringify(ev.decision, null, 2)}`);
  }
  console.log(`\n${line}\nDone.\n${line}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("dogfood-sim: fatal:", err);
  process.exit(1);
});
