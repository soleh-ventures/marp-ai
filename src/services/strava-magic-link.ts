import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

// Magic-link signing. Wire format (eng-review A3):
//
//   base64url(payload).base64url(hmac_sha256(payload, MAGIC_LINK_SECRET))
//
// payload = "{athlete_id}|{expiry_unix}|{nonce}"
//
// athlete_id   — UUID string. Identifies which athlete the link is for.
// expiry_unix  — integer seconds since epoch. Hard cutoff = config.magicLink.ttlSeconds.
// nonce        — 16 random bytes hex, makes each link unique even for
//                two links generated in the same second for the same athlete.
//
// Verification: HMAC-equal in constant time → JSON-parse payload →
// expiry check. No DB read on validation (stateless). If we ever want
// single-use semantics, add a `magic_links` table and check + mark
// nonce here. v1 doesn't need it (5-min TTL is short enough).

const SEP = "|";

export type MagicLinkPayload = {
  athleteId: string;
  expiryUnix: number;
  nonce: string;
};

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
  // Restore padding before decoding.
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  return Buffer.from(pad ? padded + "=".repeat(4 - pad) : padded, "base64");
}

function loadSecret(): Buffer {
  // Read directly from process.env so test-time overrides and key rotation
  // take effect without a process restart.
  const s = process.env.MAGIC_LINK_SECRET ?? config.magicLink.secret;
  if (!s) {
    throw new Error(
      "MAGIC_LINK_SECRET is not set — generate one with: openssl rand -hex 32",
    );
  }
  return Buffer.from(s, "utf8");
}

export type GenerateOptions = {
  // Override now() for deterministic tests. Unix seconds.
  nowSeconds?: number;
};

export function generateMagicToken(
  athleteId: string,
  opts: GenerateOptions = {},
): string {
  const secret = loadSecret();
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiryUnix = now + config.magicLink.ttlSeconds;
  const nonce = randomBytes(16).toString("hex");
  const payload = `${athleteId}${SEP}${expiryUnix}${SEP}${nonce}`;
  const payloadBuf = Buffer.from(payload, "utf8");
  const mac = createHmac("sha256", secret).update(payloadBuf).digest();
  return `${b64urlEncode(payloadBuf)}.${b64urlEncode(mac)}`;
}

export type VerifyResult =
  | { ok: true; payload: MagicLinkPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyMagicToken(
  token: string,
  opts: GenerateOptions = {},
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadB64, macB64] = parts as [string, string];

  let payloadBuf: Buffer;
  let providedMac: Buffer;
  try {
    payloadBuf = b64urlDecode(payloadB64);
    providedMac = b64urlDecode(macB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const secret = loadSecret();
  const expectedMac = createHmac("sha256", secret).update(payloadBuf).digest();
  if (expectedMac.length !== providedMac.length) {
    // Lengths must match for timingSafeEqual to even be called; mismatch
    // is by definition a bad signature, but we still spend a constant-time
    // compare against a dummy to avoid leaking the length difference.
    timingSafeEqual(expectedMac, expectedMac);
    return { ok: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(expectedMac, providedMac)) {
    return { ok: false, reason: "bad_signature" };
  }

  const payloadText = payloadBuf.toString("utf8");
  const fields = payloadText.split(SEP);
  if (fields.length !== 3) return { ok: false, reason: "malformed" };
  const [athleteId, expiryStr, nonce] = fields as [string, string, string];
  const expiryUnix = Number.parseInt(expiryStr, 10);
  if (!Number.isFinite(expiryUnix)) return { ok: false, reason: "malformed" };

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now > expiryUnix) {
    return { ok: false, reason: "expired" };
  }

  return {
    ok: true,
    payload: { athleteId, expiryUnix, nonce },
  };
}

// Build the runner-facing magic-link URL. Base URL comes from
// TWILIO_PUBLIC_WEBHOOK_BASE so the same ngrok / Railway public hostname
// is reused for OAuth start.
export function buildMagicLinkUrl(athleteId: string): string {
  const base = config.twilio.publicWebhookBase.replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "TWILIO_PUBLIC_WEBHOOK_BASE is not set — required to build magic-link URLs",
    );
  }
  const token = generateMagicToken(athleteId);
  return `${base}/auth/strava/start?token=${encodeURIComponent(token)}`;
}
