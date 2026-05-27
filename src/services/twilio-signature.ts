import { createHmac, timingSafeEqual } from "node:crypto";

// Twilio signs every webhook request with HMAC-SHA1 over:
//   the absolute URL (including query string, no fragment) +
//   each POST param's name + value, sorted alphabetically by name,
//   concatenated with no separator.
// The result is base64-encoded and sent as the `X-Twilio-Signature` header.
// See: https://www.twilio.com/docs/usage/webhooks/webhooks-security

export function computeSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const sortedNames = Object.keys(params).sort();
  let payload = url;
  for (const name of sortedNames) {
    payload += name + (params[name] ?? "");
  }
  return createHmac("sha1", authToken).update(payload, "utf8").digest("base64");
}

export function verifySignature(
  authToken: string,
  expected: string | null | undefined,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!authToken || !expected) return false;
  const computed = computeSignature(authToken, url, params);
  // Constant-time compare to prevent signature timing attacks. Buffers must
  // be equal-length first or timingSafeEqual throws.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(computed, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
