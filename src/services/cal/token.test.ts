import { beforeAll, describe, expect, test } from "bun:test";
import { generateCalToken, verifyCalToken } from "./token.js";

beforeAll(() => {
  // Ensure a secret is set for tests
  process.env.MAGIC_LINK_SECRET ||= "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
});

describe("generateCalToken / verifyCalToken", () => {
  test("round-trips a valid token", () => {
    const athleteId = "11111111-2222-3333-4444-555555555555";
    const sessionDate = "2026-06-10";
    const token = generateCalToken(athleteId, sessionDate, { nowSeconds: 1717000000 });

    const v = verifyCalToken(token, { nowSeconds: 1717000000 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.athleteId).toBe(athleteId);
      expect(v.payload.sessionDate).toBe(sessionDate);
    }
  });

  test("rejects a tampered payload", () => {
    const athleteId = "11111111-2222-3333-4444-555555555555";
    const token = generateCalToken(athleteId, "2026-06-10");
    const [_payload, mac] = token.split(".");
    // Swap the payload with someone else's id
    const fakePayload = Buffer.from(
      `99999999-9999-9999-9999-999999999999|2026-06-10|9999999999`,
      "utf8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const tampered = `${fakePayload}.${mac}`;
    const v = verifyCalToken(tampered);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("bad_signature");
  });

  test("rejects an expired token", () => {
    const athleteId = "11111111-2222-3333-4444-555555555555";
    const sessionDate = "2026-01-01"; // long-past
    const token = generateCalToken(athleteId, sessionDate);
    // "Now" = far in the future
    const v = verifyCalToken(token, { nowSeconds: 99_999_999_999 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });

  test("rejects malformed token (no dot)", () => {
    const v = verifyCalToken("notatoken");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("malformed");
  });

  test("rejects malformed session date in generate", () => {
    expect(() => generateCalToken("athlete", "not-a-date")).toThrow();
  });
});
