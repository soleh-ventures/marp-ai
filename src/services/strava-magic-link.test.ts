import { describe, expect, test, beforeAll } from "bun:test";
import {
  generateMagicToken,
  verifyMagicToken,
  buildMagicLinkUrl,
} from "./strava-magic-link.js";
import { randomBytes } from "node:crypto";

const ATHLETE_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

beforeAll(() => {
  process.env.MAGIC_LINK_SECRET = randomBytes(32).toString("hex");
  process.env.TWILIO_PUBLIC_WEBHOOK_BASE = "https://example.ngrok.io";
});

describe("generateMagicToken / verifyMagicToken", () => {
  test("round-trip: verify returns ok=true with correct payload", () => {
    const now = 1_700_000_000;
    const token = generateMagicToken(ATHLETE_ID, { nowSeconds: now });
    const result = verifyMagicToken(token, { nowSeconds: now + 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.athleteId).toBe(ATHLETE_ID);
      expect(result.payload.expiryUnix).toBe(now + 300);
    }
  });

  test("expired token returns ok=false reason=expired", () => {
    const now = 1_700_000_000;
    const token = generateMagicToken(ATHLETE_ID, { nowSeconds: now });
    // Verify 301 seconds later — 1 second past the 5-min TTL.
    const result = verifyMagicToken(token, { nowSeconds: now + 301 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  test("token at exact expiry boundary is still valid", () => {
    const now = 1_700_000_000;
    const token = generateMagicToken(ATHLETE_ID, { nowSeconds: now });
    // expiryUnix = now + 300; now > expiry is false when equal.
    const result = verifyMagicToken(token, { nowSeconds: now + 300 });
    expect(result.ok).toBe(true);
  });

  test("tampered payload returns ok=false reason=bad_signature", () => {
    const token = generateMagicToken(ATHLETE_ID);
    // Flip the last char of the payload segment to corrupt HMAC.
    const [payload, mac] = token.split(".");
    const tampered = `${payload!.slice(0, -1)}x.${mac}`;
    const result = verifyMagicToken(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_signature");
  });

  test("truncated token returns ok=false reason=malformed", () => {
    const result = verifyMagicToken("notadottoken");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  test("each generated token is unique (nonce)", () => {
    const now = 1_700_000_000;
    const t1 = generateMagicToken(ATHLETE_ID, { nowSeconds: now });
    const t2 = generateMagicToken(ATHLETE_ID, { nowSeconds: now });
    expect(t1).not.toBe(t2);
  });
});

describe("buildMagicLinkUrl", () => {
  test("URL contains /auth/strava/start and a token query param", () => {
    const url = buildMagicLinkUrl(ATHLETE_ID);
    expect(url).toContain("/auth/strava/start");
    expect(url).toContain("token=");
  });

  test("embedded token passes verification", () => {
    const url = buildMagicLinkUrl(ATHLETE_ID);
    const token = new URL(url).searchParams.get("token")!;
    const result = verifyMagicToken(token);
    expect(result.ok).toBe(true);
  });
});
