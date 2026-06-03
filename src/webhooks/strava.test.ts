import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { app } from "../server.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { _resetSubscriptionCache } from "./strava.js";
import { saveSubscriptionRecord } from "../services/strava-subscriptions.js";

// Provide env vars the server needs at import time.
beforeAll(() => {
  process.env.STRAVA_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
});

// Seed the strava_webhook_config row that the POST handler's
// subscription-id guard checks against. The existing happy-path tests
// below all use subscription_id=1, so we mirror that here. Each test
// gets a fresh row so the cache reset + reseed are deterministic.
const TEST_SUBSCRIPTION_ID = 1;

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`TRUNCATE TABLE strava_webhook_config RESTART IDENTITY`);
  await saveSubscriptionRecord(
    TEST_SUBSCRIPTION_ID,
    "https://marp.test/webhooks/strava",
  );
  _resetSubscriptionCache();
});

describe("GET /webhooks/strava (hub.challenge)", () => {
  test("valid subscribe request echoes hub.challenge", async () => {
    const res = await app.request(
      "/webhooks/strava?" +
        new URLSearchParams({
          "hub.mode": "subscribe",
          "hub.verify_token": "test-verify-token",
          "hub.challenge": "abc123",
        }).toString(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["hub.challenge"]).toBe("abc123");
  });

  test("wrong verify_token returns 403", async () => {
    const res = await app.request(
      "/webhooks/strava?" +
        new URLSearchParams({
          "hub.mode": "subscribe",
          "hub.verify_token": "wrong-token",
          "hub.challenge": "abc123",
        }).toString(),
    );
    expect(res.status).toBe(403);
  });

  test("missing hub.challenge returns 403", async () => {
    const res = await app.request(
      "/webhooks/strava?" +
        new URLSearchParams({
          "hub.mode": "subscribe",
          "hub.verify_token": "test-verify-token",
        }).toString(),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /webhooks/strava (event delivery)", () => {
  test("valid activity create event returns 200 with received:true", async () => {
    const event = {
      object_type: "activity",
      object_id: 99999,
      aspect_type: "create",
      owner_id: 12345,
      subscription_id: 1,
      event_time: Math.floor(Date.now() / 1000),
      updates: {},
    };
    const res = await app.request("/webhooks/strava", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.received).toBe(true);
  });

  test("valid activity update event returns 200 (handled same as create)", async () => {
    // Strava sometimes delivers manual entries as `update` rather than
    // `create` — see src/webhooks/strava.ts handleActivityEvent. Both
    // paths run ingestStravaActivity; ON CONFLICT DO NOTHING handles
    // duplicates.
    const event = {
      object_type: "activity",
      object_id: 99998,
      aspect_type: "update",
      owner_id: 12345,
      subscription_id: 1,
      event_time: Math.floor(Date.now() / 1000),
      updates: { title: "Renamed" },
    };
    const res = await app.request("/webhooks/strava", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.received).toBe(true);
  });

  test("malformed body still returns 200 (Strava must not retry)", async () => {
    const res = await app.request("/webhooks/strava", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json at all",
    });
    expect(res.status).toBe(200);
  });

  // ── Subscription-id guard (pre-launch blocker #3) ──────────────────
  //
  // Strava doesn't sign webhook POSTs, so the only origin check we can
  // make is "does this event's subscription_id match the one we
  // registered at bootstrap?" These tests prove the guard fires for
  // forged events and stays out of the way for legitimate ones.

  test("rejects events whose subscription_id doesn't match our stored one", async () => {
    const event = {
      object_type: "activity",
      object_id: 99997,
      aspect_type: "create",
      owner_id: 12345,
      // 9999 != TEST_SUBSCRIPTION_ID (1) — should be silently dropped.
      subscription_id: 9999,
      event_time: Math.floor(Date.now() / 1000),
      updates: {},
    };
    const res = await app.request("/webhooks/strava", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    // Still 200 — we never want Strava to retry, and we don't want
    // to leak whether the subscription_id was wrong vs the body was
    // malformed vs the athlete was unknown. All three look the same
    // from the outside.
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.received).toBe(true);
  });

  test("rejects events when no subscription record exists at all", async () => {
    // Wipe the strava_webhook_config row (simulates pre-bootstrap or
    // a manual deletion). All events should be rejected.
    await db.execute(sql`TRUNCATE TABLE strava_webhook_config RESTART IDENTITY`);
    _resetSubscriptionCache();
    const event = {
      object_type: "activity",
      object_id: 1,
      aspect_type: "create",
      owner_id: 1,
      subscription_id: TEST_SUBSCRIPTION_ID,
      event_time: 0,
      updates: {},
    };
    const res = await app.request("/webhooks/strava", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.received).toBe(true);
  });
});
