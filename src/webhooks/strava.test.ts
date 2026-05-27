import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../server.js";

// Provide env vars the server needs at import time.
beforeAll(() => {
  process.env.STRAVA_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
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

  test("malformed body still returns 200 (Strava must not retry)", async () => {
    const res = await app.request("/webhooks/strava", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json at all",
    });
    expect(res.status).toBe(200);
  });
});
