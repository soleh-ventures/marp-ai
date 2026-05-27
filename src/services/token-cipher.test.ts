import { describe, expect, test, beforeAll } from "bun:test";
import { encryptToken, decryptToken, _generateKeyHex } from "./token-cipher.js";

// Give every test in this file a valid key without touching process.env
// globally (avoids polluting parallel test runs).
beforeAll(() => {
  process.env.STRAVA_TOKEN_ENCRYPTION_KEY = _generateKeyHex();
});

describe("encryptToken / decryptToken", () => {
  test("round-trip: decrypted value equals original plaintext", () => {
    const plain = "my-super-secret-access-token";
    const cipher = encryptToken(plain);
    expect(decryptToken(cipher)).toBe(plain);
  });

  test("ciphertext is not the plaintext", () => {
    const plain = "access_abc123";
    const cipher = encryptToken(plain);
    expect(cipher).not.toContain(plain);
  });

  test("two encryptions of the same plaintext differ (random IV)", () => {
    const plain = "same-plaintext";
    const c1 = encryptToken(plain);
    const c2 = encryptToken(plain);
    expect(c1).not.toBe(c2);
    // But both decrypt correctly.
    expect(decryptToken(c1)).toBe(plain);
    expect(decryptToken(c2)).toBe(plain);
  });

  test("wire format: three colon-separated base64 segments", () => {
    const cipher = encryptToken("hello");
    const parts = cipher.split(":");
    expect(parts).toHaveLength(3);
    // Each part decodes without throwing.
    for (const p of parts) {
      expect(() => Buffer.from(p ?? "", "base64")).not.toThrow();
    }
  });

  test("tampered ciphertext throws on decrypt", () => {
    const cipher = encryptToken("original");
    // Flip a byte in the ciphertext segment.
    const parts = cipher.split(":");
    const ctPart = parts[2];
    const ct = Buffer.from(ctPart ?? "", "base64");
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    const tampered = [parts[0], parts[1], ct.toString("base64")].join(":");
    expect(() => decryptToken(tampered)).toThrow();
  });

  test("malformed ciphertext throws on decrypt", () => {
    expect(() => decryptToken("notbase64:two:parts")).toThrow();
    expect(() => decryptToken("only-one-part")).toThrow();
  });
});
