import { Hono } from "hono";
import { config } from "../config.js";

export const stravaWebhook = new Hono();

// ── GET /webhooks/strava ─────────────────────────────────────────────────
//
// Strava calls this once when you create a webhook subscription to verify
// the callback URL. We echo back hub.challenge if the verify_token matches.
//
// curl "https://www.strava.com/api/v3/push_subscriptions" \
//   -F client_id=$STRAVA_CLIENT_ID \
//   -F client_secret=$STRAVA_CLIENT_SECRET \
//   -F callback_url=$BASE/webhooks/strava \
//   -F verify_token=$STRAVA_WEBHOOK_VERIFY_TOKEN
stravaWebhook.get("/", (c) => {
  const mode = c.req.query("hub.mode");
  const verifyToken = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  // Read the token directly from process.env so test-time overrides work
  // (config is evaluated at import time, before test beforeAll hooks run).
  const expectedToken =
    process.env.STRAVA_WEBHOOK_VERIFY_TOKEN ?? config.strava.webhookVerifyToken;
  if (
    mode !== "subscribe" ||
    !challenge ||
    verifyToken !== expectedToken
  ) {
    return c.text("forbidden", 403);
  }

  // Strava expects the exact JSON key "hub.challenge".
  return c.json({ "hub.challenge": challenge });
});

// ── POST /webhooks/strava ────────────────────────────────────────────────
//
// Strava delivers activity and athlete events here. Strava requires a
// 200 response within 2 seconds — we ack immediately and process async.
//
// Event payload shape:
//   { object_type, object_id, aspect_type, owner_id, subscription_id,
//     event_time, updates }
//
// Relevant cases for MARP:
//   object_type=activity + aspect_type=create  → new run uploaded
//   object_type=activity + aspect_type=update  → run edited (title, private)
//   object_type=athlete  + aspect_type=update  → deauthorize (updates={authorized:false})

type StravaEvent = {
  object_type: "activity" | "athlete";
  object_id: number;
  aspect_type: "create" | "update" | "delete";
  owner_id: number;
  subscription_id: number;
  event_time: number;
  updates: Record<string, unknown>;
};

// In-flight background tasks — same pattern as twilio webhook for tests.
const inFlight: Set<Promise<unknown>> = new Set();

export function pendingStravaWork(): Promise<unknown> {
  return Promise.allSettled([...inFlight]);
}

stravaWebhook.post("/", async (c) => {
  let event: StravaEvent;
  try {
    event = await c.req.json<StravaEvent>();
  } catch {
    // Malformed body — still ack 200 so Strava doesn't retry indefinitely.
    console.warn("strava webhook: failed to parse JSON body");
    return c.json({ received: true });
  }

  // Always log the inbound event shape — we used to silently skip
  // anything that wasn't a `create`, which made it impossible to tell
  // from production logs whether Strava was delivering events at all.
  console.log(
    `strava webhook event: object_type=${event.object_type} aspect_type=${event.aspect_type} ` +
      `owner_id=${event.owner_id} object_id=${event.object_id} ` +
      `subscription_id=${event.subscription_id}`,
  );

  // Subscription-id check: Strava doesn't sign webhook POSTs (their
  // API has no HMAC mechanism for events), so the only origin
  // validation we can do server-side is "does this event's
  // subscription_id match the one we registered?" An attacker who
  // learns our public webhook URL would have to also know our exact
  // numeric subscription_id to slip events past this check. We ack 200
  // either way so a misdirected event doesn't make Strava retry
  // forever, but we log the mismatch + skip processing.
  const subscriptionOk = await isExpectedSubscription(event.subscription_id);
  if (!subscriptionOk) {
    console.warn(
      `strava webhook event REJECTED: subscription_id=${event.subscription_id} ` +
        `doesn't match the one we registered`,
    );
    return c.json({ received: true });
  }

  // Deauthorization: athlete revoked our access.
  if (
    event.object_type === "athlete" &&
    event.aspect_type === "update" &&
    event.updates?.authorized === "false"
  ) {
    const task = handleDeauthorize(event.owner_id).catch((err) => {
      console.error("strava webhook: deauthorize handler error", err);
    }).finally(() => inFlight.delete(task));
    inFlight.add(task);
    return c.json({ received: true });
  }

  // New or updated activity.
  if (event.object_type === "activity" && event.aspect_type !== "delete") {
    const task = handleActivityEvent(event).catch((err) => {
      console.error("strava webhook: activity handler error", err);
    }).finally(() => inFlight.delete(task));
    inFlight.add(task);
  }

  return c.json({ received: true });
});

async function handleDeauthorize(stravaAthleteId: number): Promise<void> {
  // Lazy-import to keep the top-level bundle light and avoid DB calls at
  // module init time (which breaks unit tests that don't set DATABASE_URL).
  const { findByStravaAthleteId, markRevoked } = await import(
    "../services/strava-connections.js"
  );
  const conn = await findByStravaAthleteId(stravaAthleteId);
  if (conn) {
    await markRevoked(conn.id);
    console.log(
      `strava webhook: marked connection revoked for strava_athlete_id=${stravaAthleteId}`,
    );
  }
}

async function handleActivityEvent(event: StravaEvent): Promise<void> {
  // Ingest on both `create` and `update`. Strava's docs say manual
  // entries fire `create`, but in practice we've observed manual entries
  // (and some app uploads) arriving as `update` instead — without this,
  // those activities never landed. Ingest uses ON CONFLICT DO NOTHING,
  // so a true edit of an already-ingested row is a cheap no-op after
  // the Strava API fetch. Acceptable v1 trade-off vs. losing manual runs.
  if (event.aspect_type !== "create" && event.aspect_type !== "update") {
    return;
  }

  const { ingestStravaActivity } = await import(
    "../services/strava-activities.js"
  );
  const result = await ingestStravaActivity(event.owner_id, event.object_id);
  console.log(
    `strava webhook: ingest owner_id=${event.owner_id} object_id=${event.object_id} ` +
      `aspect=${event.aspect_type} inserted=${result.inserted}` +
      `${result.reason ? ` reason=${result.reason}` : ""}`,
  );

  // M1 (T2/T3): only a genuinely NEW activity triggers the post-run pipeline
  // (analysis + check-in). Redelivered `update` events that hit ON CONFLICT
  // DO NOTHING return inserted=false and are skipped — no duplicate check-ins.
  // The pipeline is fault-isolated internally; runs inside this same
  // fire-and-forget task so tests' pendingStravaWork() awaits it.
  if (result.inserted && result.athleteId && result.activityId) {
    const { runPostRunPipeline } = await import("../services/run-analysis.js");
    await runPostRunPipeline({
      athleteId: result.athleteId,
      activityId: result.activityId,
    });
  }
}

// Validate the event's subscription_id against the one we registered
// with Strava during bootstrap. Cached after first DB hit because the
// subscription_id is effectively immutable for the lifetime of the
// service (it changes only when we re-run bootstrap with a new
// callback URL, which is a deploy-time event).
let cachedSubscriptionId: number | null = null;
async function isExpectedSubscription(eventSubId: number): Promise<boolean> {
  if (cachedSubscriptionId !== null) {
    return eventSubId === cachedSubscriptionId;
  }
  const { getActiveSubscriptionRecord } = await import(
    "../services/strava-subscriptions.js"
  );
  const record = await getActiveSubscriptionRecord();
  if (!record) {
    // No subscription configured yet → reject everything. Either we
    // haven't run bootstrap, or someone deleted the row. Either way,
    // refuse the event rather than guess.
    return false;
  }
  cachedSubscriptionId = record.subscriptionId;
  return eventSubId === cachedSubscriptionId;
}

// Test-only: reset the subscription cache so a freshly-seeded row
// gets picked up on the next webhook call. Production code never
// calls this.
export function _resetSubscriptionCache(): void {
  cachedSubscriptionId = null;
}
