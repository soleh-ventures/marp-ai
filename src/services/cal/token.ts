// V9 (v1.1 flow redesign) — calendar token signing.
//
// Mirrors src/services/strava-magic-link.ts's HMAC pattern but with a
// calendar-specific payload (athleteId | sessionDate). Single-use is
// NOT enforced — a runner may legitimately re-tap a calendar link
// (different device, lost the email). TTL = session date + 1 day so
// past sessions don't keep producing live links forever.
//
// Wire format:
//   base64url(payload).base64url(hmac_sha256(payload, MAGIC_LINK_SECRET))
//
// payload = "{athlete_id}|{session_date_yyyy_mm_dd}|{expiry_unix}"

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";

const SEP = "|";

export type CalTokenPayload = {
  athleteId: string;
  sessionDate: string;
  expiryUnix: number;
};

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  return Buffer.from(pad ? padded + "=".repeat(4 - pad) : padded, "base64");
}

function loadSecret(): Buffer {
  const s = process.env.MAGIC_LINK_SECRET ?? config.magicLink.secret;
  if (!s) {
    throw new Error(
      "MAGIC_LINK_SECRET is not set — required for calendar token signing",
    );
  }
  return Buffer.from(s, "utf8");
}

export type GenerateCalOptions = {
  // Override now() for deterministic tests. Unix seconds.
  nowSeconds?: number;
};

export function generateCalToken(
  athleteId: string,
  sessionDate: string,
  opts: GenerateCalOptions = {},
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
    throw new Error(`generateCalToken: invalid sessionDate ${sessionDate}`);
  }
  const secret = loadSecret();
  // Expiry = end of the session's day + 24h buffer for late taps.
  const sessionEndUnix =
    Math.floor(new Date(`${sessionDate}T23:59:59Z`).getTime() / 1000);
  const expiryUnix = sessionEndUnix + 24 * 60 * 60;
  const payload = `${athleteId}${SEP}${sessionDate}${SEP}${expiryUnix}`;
  const payloadBuf = Buffer.from(payload, "utf8");
  const mac = createHmac("sha256", secret).update(payloadBuf).digest();
  return `${b64urlEncode(payloadBuf)}.${b64urlEncode(mac)}`;
}

export type VerifyCalResult =
  | { ok: true; payload: CalTokenPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyCalToken(
  token: string,
  opts: GenerateCalOptions = {},
): VerifyCalResult {
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
    timingSafeEqual(expectedMac, expectedMac);
    return { ok: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(expectedMac, providedMac)) {
    return { ok: false, reason: "bad_signature" };
  }

  const fields = payloadBuf.toString("utf8").split(SEP);
  if (fields.length !== 3) return { ok: false, reason: "malformed" };
  const [athleteId, sessionDate, expiryStr] = fields as [string, string, string];
  const expiryUnix = Number.parseInt(expiryStr, 10);
  if (!Number.isFinite(expiryUnix)) return { ok: false, reason: "malformed" };

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now > expiryUnix) return { ok: false, reason: "expired" };

  return { ok: true, payload: { athleteId, sessionDate, expiryUnix } };
}
