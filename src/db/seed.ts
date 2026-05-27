import { sql } from "drizzle-orm";
import { db, sqlClient } from "./client.js";
import {
  activeFlags,
  activities,
  athletes,
  llmCalls,
  messages,
  processedMessages,
  raceBlocks,
} from "./schema.js";

async function reset() {
  // Order matters only when FKs are RESTRICT; ours are CASCADE/SET NULL, but
  // TRUNCATE ... CASCADE is explicit so the script doesn't drift if FK
  // behaviour ever tightens.
  await db.execute(sql`
    TRUNCATE TABLE
      llm_calls,
      processed_messages,
      messages,
      active_flags,
      activities,
      race_blocks,
      athletes
    RESTART IDENTITY CASCADE
  `);
}

async function seedHappyPath() {
  const [athlete] = await db
    .insert(athletes)
    .values({
      phone: "+15551234567",
      name: "Test Runner",
      locale: "en",
      athleticHistory: {
        years_running: 4,
        prior_races: [{ distance: "half", time: "1:52:00", year: 2024 }],
        prior_injuries: ["IT band — 2023"],
      },
    })
    .returning();
  if (!athlete) throw new Error("athlete insert returned nothing");

  const [block] = await db
    .insert(raceBlocks)
    .values({
      athleteId: athlete.id,
      raceName: "Jakarta Marathon 2026",
      raceDate: new Date("2026-10-25T00:00:00Z"),
      raceDistance: "marathon",
      goalFinishTime: "4:00:00",
      state: "active",
      plan: { weeks: 16, peak_mileage_km: 65 },
    })
    .returning();
  if (!block) throw new Error("race_block insert returned nothing");

  const [activity] = await db
    .insert(activities)
    .values({
      athleteId: athlete.id,
      raceBlockId: block.id,
      discipline: "run",
      source: "strava",
      startedAt: new Date("2026-05-18T06:00:00Z"),
      durationS: 5400,
      metrics: { distance_km: 14.2, avg_hr: 152, elev_gain_m: 88 },
      rawPayload: { strava_activity_id: 999999999 },
      longRun: true,
    })
    .returning();
  if (!activity) throw new Error("activity insert returned nothing");

  await db.insert(activeFlags).values({
    athleteId: athlete.id,
    kind: "injury",
    body: "left achilles tightness, 3/10 fades during warmup",
  });

  const [message] = await db
    .insert(messages)
    .values({
      athleteId: athlete.id,
      direction: "in",
      body: "knee feeling weird today, should i still run?",
      twilioMessageSid: "SM_seed_test_001",
    })
    .returning();
  if (!message) throw new Error("message insert returned nothing");

  await db.insert(processedMessages).values({
    twilioMessageSid: "SM_seed_test_001",
  });

  await db.insert(llmCalls).values({
    athleteId: athlete.id,
    messageId: message.id,
    component: "classifier",
    model: "claude-haiku-4-5",
    tokensIn: 850,
    tokensOut: 12,
    costEstimateUsd: 0.000425,
    latencyMs: 320,
  });

  return { athlete, block, activity, message };
}

async function assertForeignKeyEnforced() {
  const fakeId = "00000000-0000-0000-0000-000000000000";
  try {
    await db.insert(raceBlocks).values({
      athleteId: fakeId,
      raceName: "Phantom Race",
      raceDate: new Date("2099-01-01T00:00:00Z"),
      raceDistance: "marathon",
    });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("foreign key") || msg.includes("violates")) {
      return; // expected
    }
    throw new Error(`expected FK violation, got: ${msg}`);
  }
  throw new Error("FK violation was NOT raised — schema is broken");
}

async function main() {
  console.log("→ truncating tables");
  await reset();

  console.log("→ seeding happy path");
  const { athlete } = await seedHappyPath();
  console.log(`  inserted athlete ${athlete.id} (${athlete.phone})`);

  console.log("→ asserting FK violation on bogus athlete_id");
  await assertForeignKeyEnforced();
  console.log("  ✓ FK enforced");

  await sqlClient.end();
  console.log("done");
}

await main();
