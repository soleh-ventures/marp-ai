import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { app } from "../server.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import {
  activities,
  activityAnalyses,
  athletes,
  messages,
  planAdjustments,
  stravaConnections,
} from "../db/schema.js";
import { getAthleticHistory } from "../flows/onboarding.js";
import { _resetProviderCache, mockProvider } from "./llm/index.js";
import { getStoredPlan, saveAthletePlan } from "./plan/storage.js";
import { parsePlan } from "./plan/types.js";
import { encryptToken } from "./token-cipher.js";
import { saveSubscriptionRecord } from "./strava-subscriptions.js";
import { _resetSubscriptionCache, pendingStravaWork } from "../webhooks/strava.js";
import { extractRunFeeling } from "./run-feeling.js";
import { applyProposalResolution, runWeeklyRetro } from "./run-retro.js";

// T10 (KER-69) — full adaptive-loop E2E. Composes the REAL seams in sequence
// with a mocked LLM at each, proving the loop holds together end to end:
//
//   Strava run lands (webhook) → objective analysis stored
//     → runner reply → RunFeeling extracted + stored on the same row
//       → retro proposes a plan change (recorded as a pending decision)
//         → runner accepts → adjustPlan applies it → plan mutated + logged.

const STRAVA_ATHLETE_ID = 553311;
const SUB_ID = 1;

const FAKE_ACTIVITY = {
  id: 42424,
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

const PLAN = parsePlan({
  source: "generated",
  start_date: "2026-06-08",
  weeks: [
    {
      index: 1,
      sessions: [
        { day_of_week: "monday", type: "rest", description: "Rest" },
        { day_of_week: "thursday", type: "tempo", description: "Tempo 8K, RPE 6-7" },
        { day_of_week: "sunday", type: "long", description: "Long 20K, RPE 5" },
      ],
    },
  ],
});

const MODIFIED_PLAN_JSON = JSON.stringify({
  source: "generated",
  start_date: "2026-06-08",
  weeks: [
    {
      index: 1,
      sessions: [
        { day_of_week: "monday", type: "rest", description: "Rest" },
        { day_of_week: "thursday", type: "easy", description: "Easy 6K, RPE 3-4" },
        { day_of_week: "sunday", type: "long", description: "Long 18K, RPE 5" },
      ],
    },
  ],
});

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
  mockProvider.setResponses([
    { match: "coach's read", text: "Even splits, HR steady — controlled aerobic run." },
    {
      match: "about a 7",
      text: JSON.stringify({
        feeling: {
          effort: { rpe: 7, band: "moderate" },
          energy: "neutral",
          pain: { present: false, location: null, severity: null },
          adherence: "as_planned",
          context: null,
        },
      }),
    },
    {
      match: "Decide whether to adjust",
      text: JSON.stringify({
        adjust: true,
        summary: "Ease Thursday",
        rationale: "Recurring fatigue signals — swap the quality day, 80/20.",
        edit_request: "Turn Thursday's tempo into an easy run and trim the long run a touch.",
        decision_frame: {
          question: "Want me to ease Thursday to easy?",
          options: [
            { key: "accept", label: "Yes, ease it" },
            { key: "keep", label: "Keep it" },
          ],
        },
      }),
    },
    { match: "Apply ONLY that change", text: MODIFIED_PLAN_JSON },
  ]);
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

async function seed(): Promise<string> {
  const [a] = await db
    .insert(athletes)
    .values({ phone: "+15551117000", name: "Runner", timezone: "Europe/Berlin" })
    .returning();
  if (!a) throw new Error("athlete insert failed");
  await saveAthletePlan(a.id, PLAN);
  await db.insert(stravaConnections).values({
    athleteId: a.id,
    stravaAthleteId: STRAVA_ATHLETE_ID,
    encryptedAccessToken: encryptToken("access-x"),
    encryptedRefreshToken: encryptToken("refresh-x"),
    tokenExpiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
    scope: "read,activity:read_all",
  });
  return a.id;
}

async function insertInbound(athleteId: string, body: string): Promise<string> {
  const [m] = await db
    .insert(messages)
    .values({ athleteId, direction: "in", body })
    .returning({ id: messages.id });
  if (!m) throw new Error("message insert failed");
  return m.id;
}

async function thursdayType(athleteId: string): Promise<string | undefined> {
  const [a] = await db.select({ ah: athletes.athleticHistory }).from(athletes).where(eq(athletes.id, athleteId));
  return getStoredPlan(getAthleticHistory(a?.ah))?.weeks[0]?.sessions.find((s) => s.day_of_week === "thursday")?.type;
}

describe("M1 adaptive loop — full E2E", () => {
  test("run → analysis → feeling → retro proposal → accept → plan applied", async () => {
    const athleteId = await seed();

    // 1) Strava run lands via the webhook → objective analysis stored.
    const res = await app.request("/webhooks/strava", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        object_type: "activity",
        object_id: 42424,
        aspect_type: "create",
        owner_id: STRAVA_ATHLETE_ID,
        subscription_id: SUB_ID,
        event_time: Math.floor(Date.now() / 1000),
        updates: {},
      }),
    });
    expect(res.status).toBe(200);
    await pendingStravaWork();
    const [act] = await db.select().from(activities).where(eq(activities.athleteId, athleteId));
    expect(act).toBeDefined();
    let [analysis] = await db.select().from(activityAnalyses).where(eq(activityAnalyses.athleteId, athleteId));
    expect((analysis?.objective as { source?: string })?.source).toBe("splits");

    // 2) Runner replies → RunFeeling extracted onto the same row.
    const replyId = await insertInbound(athleteId, "legs felt ok, about a 7, did it as planned");
    const fr = await extractRunFeeling({ athleteId, messageId: replyId, body: "legs felt ok, about a 7, did it as planned" });
    expect(fr.captured).toBe(true);
    [analysis] = await db.select().from(activityAnalyses).where(eq(activityAnalyses.athleteId, athleteId));
    expect((analysis?.objective as { source?: string })?.source).toBe("splits"); // preserved
    expect((analysis?.feeling as { effort?: { rpe?: number } })?.effort?.rpe).toBe(7); // added

    // 3) Retro proposes a change (event trigger) → recorded as a pending decision.
    const retro = await runWeeklyRetro({ athleteId, weekStart: "2026-06-08", trigger: "event" });
    expect(retro.proposed).toBe(true);
    if (!retro.proposed) throw new Error("expected a proposal");
    expect(await thursdayType(athleteId)).toBe("tempo"); // not changed yet

    // 4) Runner accepts → adjustPlan applies it → plan mutated + logged.
    const acceptId = await insertInbound(athleteId, "yes");
    const applied = await applyProposalResolution({
      athleteId,
      messageId: acceptId,
      frameId: retro.pendingDecisionId,
      key: "accept",
    });
    expect(applied).toEqual({ applied: true, status: "applied" });
    expect(await thursdayType(athleteId)).toBe("easy"); // plan mutated end to end

    const [adj] = await db.select().from(planAdjustments).where(eq(planAdjustments.athleteId, athleteId));
    expect(adj?.status).toBe("applied");
    expect(adj?.appliedAt).not.toBeNull();
  });
});
