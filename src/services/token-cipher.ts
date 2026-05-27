import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { config } from "../config.js";

// AES-256-GCM for encrypting Strava OAuth tokens at rest.
//
// Eng review chose this over pgcrypto pgp_sym_* — both are symmetric
// AES-256, identical security properties. App-side trades the DB-extension
// dependency for slightly more code; the gain is straightforward testing
// (no SQL fn round-trips in unit tests) and trivial key rotation later.
//
// Wire format: base64(iv) + ":" + base64(authTag) + ":" + base64(ciphertext)
// Three discrete fields, colon-delimited. Each field is base64-encoded
// so the whole string stays ASCII-safe and short. Decoding is a single
// split — no parser to break.

const ALGO = "aes-256-gcm" as const;
const IV_LEN = 12; // 96-bit IV is the standard recommendation for GCM
const KEY_LEN = 32; // 256-bit key

function loadKey(): Buffer {
  // Read directly from process.env so key rotation and test-time overrides
  // take effect without restarting the process.
  const hex = process.env.STRAVA_TOKEN_ENCRYPTION_KEY ?? config.strava.tokenEncryptionKey;
  if (!hex) {
    throw new Error(
      "STRAVA_TOKEN_ENCRYPTION_KEY is not set — generate one with: openssl rand -hex 32",
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_LEN) {
    throw new Error(
      `STRAVA_TOKEN_ENCRYPTION_KEY must be exactly ${KEY_LEN} bytes (${KEY_LEN * 2} hex chars), got ${key.length} bytes`,
    );
  }
  return key;
}

export function encryptToken(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptToken(ciphertext: string): string {
  const key = loadKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error(`encrypted token: expected 3 colon-separated parts, got ${parts.length}`);
  }
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_LEN) {
    throw new Error(`encrypted token: IV length ${iv.length}, expected ${IV_LEN}`);
  }
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString("utf8");
}

// Test-only helper for generating a key in fixtures. Not exported through
// the index so callers can't accidentally generate one in prod.
export function _generateKeyHex(): string {
  return randomBytes(KEY_LEN).toString("hex");
}
