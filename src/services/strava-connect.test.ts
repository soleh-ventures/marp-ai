import { describe, expect, test, beforeAll } from "bun:test";
import {
  looksLikeStravaConnect,
  buildConnectReply,
} from "./strava-connect.js";
import { randomBytes } from "node:crypto";

beforeAll(() => {
  process.env.MAGIC_LINK_SECRET = randomBytes(32).toString("hex");
  process.env.TWILIO_PUBLIC_WEBHOOK_BASE = "https://example.ngrok.io";
});

describe("looksLikeStravaConnect", () => {
  const positives = [
    "connect strava",
    "connect my strava",
    "link strava",
    "link my strava please",
    "I want to add strava",
    "sync strava",
    "strava connect",
    "strava link",
    "strava sync",
    "can you attach strava",
  ];

  const negatives = [
    "how do i pace my long run",
    "what is strava",
    "I use strava",
    "strava says my vo2max is 52",
    "my strava data",
  ];

  for (const msg of positives) {
    test(`detects: "${msg}"`, () => {
      expect(looksLikeStravaConnect(msg)).toBe(true);
    });
  }

  for (const msg of negatives) {
    test(`ignores: "${msg}"`, () => {
      expect(looksLikeStravaConnect(msg)).toBe(false);
    });
  }
});

describe("buildConnectReply", () => {
  test("already_connected — no link in reply", () => {
    const reply = buildConnectReply({ kind: "already_connected" });
    expect(reply).toContain("already connected");
    expect(reply).not.toContain("http");
  });

  test("not_connected — includes the magic link URL", () => {
    const reply = buildConnectReply({
      kind: "not_connected",
      linkUrl: "https://example.ngrok.io/auth/strava/start?token=abc",
    });
    expect(reply).toContain("https://example.ngrok.io/auth/strava/start");
    expect(reply).toContain("5 minute");
  });

  test("revoked — includes reconnect language + link", () => {
    const reply = buildConnectReply({
      kind: "revoked",
      linkUrl: "https://example.ngrok.io/auth/strava/start?token=xyz",
    });
    expect(reply).toMatch(/disconnected|removed/i);
    expect(reply).toContain("https://example.ngrok.io/auth/strava/start");
  });

  test("not_configured — no link, developer hint", () => {
    const reply = buildConnectReply({ kind: "not_configured" });
    expect(reply).not.toContain("http");
    expect(reply).toContain("TWILIO_PUBLIC_WEBHOOK_BASE");
  });
});
