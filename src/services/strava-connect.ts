import { buildMagicLinkUrl } from "./strava-magic-link.js";
import { findByAthleteId } from "./strava-connections.js";
import { config } from "../config.js";

// Patterns that clearly signal the runner wants to connect Strava.
// Kept simple and high-precision — false negatives are fine (the runner
// can just say it more plainly). False positives would be annoying.
const CONNECT_PATTERNS = [
  /connect\b.{0,20}\bstrava/i,
  /strava\b.{0,20}\bconnect/i,
  /link\b.{0,20}\bstrava/i,
  /strava\b.{0,20}\blink/i,
  /add\b.{0,20}\bstrava/i,
  /sync\b.{0,20}\bstrava/i,
  /strava\b.{0,20}\bsync/i,
  /attach\b.{0,20}\bstrava/i,
];

export function looksLikeStravaConnect(message: string): boolean {
  return CONNECT_PATTERNS.some((re) => re.test(message));
}

export type ConnectStatus =
  | { kind: "already_connected" }
  | { kind: "revoked"; linkUrl: string }
  | { kind: "not_connected"; linkUrl: string }
  | { kind: "not_configured" };

export async function getStravaConnectStatus(
  athleteId: string,
): Promise<ConnectStatus> {
  // If the public base URL isn't set, we can't generate a valid magic link.
  if (!config.twilio.publicWebhookBase) {
    return { kind: "not_configured" };
  }

  const conn = await findByAthleteId(athleteId);
  if (conn && !conn.revokedAt) {
    return { kind: "already_connected" };
  }

  const linkUrl = buildMagicLinkUrl(athleteId);
  if (conn?.revokedAt) {
    return { kind: "revoked", linkUrl };
  }
  return { kind: "not_connected", linkUrl };
}

// Strava's API went behind a paid developer subscription (June 2026), so new
// connections are OFF the menu. Existing connections (the founder's) keep
// syncing — webhook + ingest code is untouched; only the offer died. The
// honest reply names what works TODAY instead of a dead link.
export const STRAVA_UNAVAILABLE_REPLY =
  "Straight answer: Strava shut its doors on apps like me (their API went " +
  "paid for developers), so I can't connect new Strava accounts right now.\n\n" +
  "What works today:\n" +
  "• Send me a GPX file after a run (export from your watch app) — I log it\n" +
  "• Or just tell me how the run went — distance, time, how it felt\n" +
  "• ⌚ Garmin sync is coming — reply \"garmin\" and I'll put you on the " +
  "waitlist and ping you the day it's live.";

export function buildConnectReply(status: ConnectStatus): string {
  switch (status.kind) {
    case "already_connected":
      return "Your Strava is already connected — I can see your runs automatically.";
    // New connections are unavailable (paid API) — same honest reply whether
    // they were never connected, got revoked, or the server isn't configured.
    case "revoked":
    case "not_connected":
    case "not_configured":
      return STRAVA_UNAVAILABLE_REPLY;
  }
}
