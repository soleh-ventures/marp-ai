import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { app } from "../server.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { activities, activityAnalyses, athletes, stravaConnections } from "../db/schema.js";
import { _resetProviderCache, mockProvider } from "../services/llm/index.js";
import { encryptToken } from "../services/token-cipher.js";
import { saveSubscriptionRecord } from "../services/strava-subscriptions.js";
import { _resetSubscriptionCache, pendingStravaWork } from "./strava.js";

// T9 (KER-68) — CRITICAL regression for the M1 ingest trigger.
//
// Adding the post-run pipeline (analysis + check-in) to the Strava webhook
// must NOT break ingest idempotency: a redelivered `update` for an already-
// ingested activity must not create a second activity row OR a second
// analysis (the pipeline fires only on inserted=true). The 200-ack must also
// stay immediate (pipeline runs in a background task).

const STRAVA_ATHLETE_ID = 778899;
const SUB_ID = 1;

// A fake Strava activity-detail payload with per-km splits, returned by the
// stubbed fetch so ingest doesn't hit the network.
const FAKE_ACTIVITY = {
  id: 99999,
  sport_type: "Run",
  start_date: new Date().toISOString(),
  moving_time: 1800,
  distance: 6000,
  average_speed: 6000 / 1800,
  average_heartrate: 150,
  max_heartrate: 165,
  timezone: "(GMT+01:00) Europe/Berlin",
  splits_metric: [1, 2, 3, 4, 5, 6].map((i) => ({
    split: i,
    distance: 1000,
    moving_time: 300,
    average_speed: 1000 / 300,
    average_heartrate: 146 + i,
  })),
};

let realFetch: typeof globalThis.fetch;

beforeAll(() => {
  process.env.STRAVA_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
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
      pending_decisions, athletes, strava_webhook_config
    RESTART IDENTITY CASCADE
  `);
  await saveSubscriptionRecord(SUB_ID, "https://marp.test/webhooks/strava");
  _resetSubscriptionCache();
  mockProvider.reset();
  mockProvider.setResponses([{ match: "coach's read", text: "Even, controlled — clean easy run." }]);
  // Stub fetch so ingest's activity GET returns our fake payload (token is
  // seeded unexpired, so getFreshAccessToken makes no network call).
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(FAKE_ACTIVITY), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function seedAthleteWithConnection(): Promise<string> {
  const [a] = await db
    .insert(athletes)
    .values({ phone: "+15551119000", name: "Runner", timezone: "Europe/Berlin" })
    .returning();
  if (!a) throw new Error("athlete insert failed");
  await db.insert(stravaConnections).values({
    athleteId: a.id,
    stravaAthleteId: STRAVA_ATHLETE_ID,
    encryptedAccessToken: encryptToken("access-x"),
    encryptedRefreshToken: encryptToken("refresh-x"),
    tokenExpiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000), // unexpired → no refresh
    scope: "read,activity:read_all",
  });
  return a.id;
}

function event(aspect: "create" | "update") {
  return {
    object_type: "activity",
    object_id: 99999,
    aspect_type: aspect,
    owner_id: STRAVA_ATHLETE_ID,
    subscription_id: SUB_ID,
    event_time: Math.floor(Date.now() / 1000),
    updates: {},
  };
}

async function post(aspect: "create" | "update"): Promise<number> {
  const res = await app.request("/webhooks/strava", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event(aspect)),
  });
  return res.status;
}

describe("POST /webhooks/strava — M1 pipeline trigger regression (T9)", () => {
  test("new activity ingests once + runs the pipeline once", async () => {
    const athleteId = await seedAthleteWithConnection();
    expect(await post("create")).toBe(200);
    await pendingStravaWork();

    const acts = await db.select().from(activities).where(eq(activities.athleteId, athleteId));
    expect(acts).toHaveLength(1);
    const analyses = await db.select().from(activityAnalyses).where(eq(activityAnalyses.athleteId, athleteId));
    expect(analyses).toHaveLength(1);
    // Objective was computed from the stubbed splits.
    expect((analyses[0]?.objective as { source?: string })?.source).toBe("splits");
  });

  test("redelivery (update of an already-ingested activity) is idempotent — no second row, no second analysis", async () => {
    const athleteId = await seedAthleteWithConnection();
    expect(await post("create")).toBe(200);
    await pendingStravaWork();
    expect(await post("update")).toBe(200); // same object_id 99999
    await pendingStravaWork();

    const acts = await db.select().from(activities).where(eq(activities.athleteId, athleteId));
    expect(acts).toHaveLength(1); // ON CONFLICT DO NOTHING held
    const analyses = await db.select().from(activityAnalyses).where(eq(activityAnalyses.athleteId, athleteId));
    expect(analyses).toHaveLength(1); // pipeline did NOT fire again (inserted=false)
  });

  test("unknown owner (no connection) ingests nothing and triggers no pipeline", async () => {
    // No athlete/connection seeded for STRAVA_ATHLETE_ID.
    expect(await post("create")).toBe(200);
    await pendingStravaWork();
    expect(await db.select().from(activities)).toHaveLength(0);
    expect(await db.select().from(activityAnalyses)).toHaveLength(0);
  });
});
