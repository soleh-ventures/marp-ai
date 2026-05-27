import { describe, expect, test } from "bun:test";
import { computeSignature, verifySignature } from "./twilio-signature.js";

// Reference vector cross-verified against the official `twilio` Node SDK
// (twilio.getExpectedTwilioSignature) and `openssl dgst -sha1 -hmac`. Both
// produced the same value for these inputs, so our HMAC math matches Twilio.
const TWILIO_REFERENCE = {
  token: "12345",
  url: "https://mycompany.com/myapp.php?foo=1&bar=2",
  params: {
    Digits: "1234",
    To: "+18005551212",
    From: "+14158675309",
    Caller: "+14158675309",
    CallSid: "CA1234567890ABCDE",
  },
  expected: "RSOYDt4T1cUTdK1PDd93/VVr8B8=",
};

describe("computeSignature", () => {
  test("matches Twilio's published reference vector", () => {
    const sig = computeSignature(
      TWILIO_REFERENCE.token,
      TWILIO_REFERENCE.url,
      TWILIO_REFERENCE.params,
    );
    expect(sig).toBe(TWILIO_REFERENCE.expected);
  });

  test("is sensitive to param value", () => {
    const tampered = { ...TWILIO_REFERENCE.params, Digits: "9999" };
    const sig = computeSignature(
      TWILIO_REFERENCE.token,
      TWILIO_REFERENCE.url,
      tampered,
    );
    expect(sig).not.toBe(TWILIO_REFERENCE.expected);
  });

  test("is sensitive to URL", () => {
    const sig = computeSignature(
      TWILIO_REFERENCE.token,
      "https://attacker.example/myapp.php?foo=1&bar=2",
      TWILIO_REFERENCE.params,
    );
    expect(sig).not.toBe(TWILIO_REFERENCE.expected);
  });
});

describe("verifySignature", () => {
  test("accepts a valid signature", () => {
    expect(
      verifySignature(
        TWILIO_REFERENCE.token,
        TWILIO_REFERENCE.expected,
        TWILIO_REFERENCE.url,
        TWILIO_REFERENCE.params,
      ),
    ).toBe(true);
  });

  test("rejects a tampered signature", () => {
    expect(
      verifySignature(
        TWILIO_REFERENCE.token,
        "WRONG_SIGNATURE_AAAAAAAAAAAAAAAAAAAAAAAA",
        TWILIO_REFERENCE.url,
        TWILIO_REFERENCE.params,
      ),
    ).toBe(false);
  });

  test("rejects when signature is missing", () => {
    expect(
      verifySignature(
        TWILIO_REFERENCE.token,
        null,
        TWILIO_REFERENCE.url,
        TWILIO_REFERENCE.params,
      ),
    ).toBe(false);
  });

  test("rejects when auth token is empty", () => {
    expect(
      verifySignature(
        "",
        TWILIO_REFERENCE.expected,
        TWILIO_REFERENCE.url,
        TWILIO_REFERENCE.params,
      ),
    ).toBe(false);
  });

  test("rejects when a param was tampered with after signing", () => {
    expect(
      verifySignature(
        TWILIO_REFERENCE.token,
        TWILIO_REFERENCE.expected,
        TWILIO_REFERENCE.url,
        { ...TWILIO_REFERENCE.params, Digits: "9999" },
      ),
    ).toBe(false);
  });
});
