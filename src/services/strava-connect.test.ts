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
  test("already_connected — no link in reply (founder path unchanged)", () => {
    const reply = buildConnectReply({ kind: "already_connected" });
    expect(reply).toContain("already connected");
    expect(reply).not.toContain("http");
  });

  // Strava's API went paid for developers (June 2026): no new connections.
  // Every non-connected state gets the same honest reply — what works today
  // (GPX, check-ins) + the Garmin waitlist. Never a dead magic link.
  for (const kind of ["not_connected", "revoked", "not_configured"] as const) {
    test(`${kind} — honest unavailable reply, no dead link`, () => {
      const reply = buildConnectReply(
        kind === "not_configured"
          ? { kind }
          : { kind, linkUrl: "https://example.ngrok.io/auth/strava/start?token=abc" },
      );
      expect(reply).not.toContain("http");
      expect(reply.toLowerCase()).toContain("gpx");
      expect(reply.toLowerCase()).toContain("garmin");
      expect(reply.toLowerCase()).toContain("waitlist");
    });
  }
});
