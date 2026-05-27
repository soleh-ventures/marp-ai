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

export function buildConnectReply(status: ConnectStatus): string {
  switch (status.kind) {
    case "already_connected":
      return "Your Strava is already connected — I can see your runs automatically.";

    case "revoked":
      return (
        "Your Strava was disconnected (either you removed MARP's access or " +
        "the token expired). Tap the link below to reconnect — it expires in 5 minutes:\n\n" +
        status.linkUrl
      );

    case "not_connected":
      return (
        "Tap the link below to connect your Strava account. " +
        "It expires in 5 minutes, so open it now:\n\n" +
        status.linkUrl +
        "\n\nOnce you've authorised, I'll see your runs automatically."
      );

    case "not_configured":
      return (
        "Strava connection isn't set up yet on this server. " +
        "If you're the developer, set TWILIO_PUBLIC_WEBHOOK_BASE."
      );
  }
}

// Convenience: build the Strava offer to append at onboarding completion.
// Returns null if Strava is already connected or can't generate a link
// (so the onboarding reply is never cluttered unnecessarily).
export async function buildOnboardingStravaOffer(
  athleteId: string,
): Promise<string | null> {
  if (!config.twilio.publicWebhookBase) return null;
  const conn = await findByAthleteId(athleteId);
  if (conn && !conn.revokedAt) return null;

  try {
    const linkUrl = buildMagicLinkUrl(athleteId);
    return (
      "\n\nOne more thing — connect your Strava and I'll see your runs automatically " +
      "(no more manual check-ins). Link expires in 5 min:\n\n" +
      linkUrl
    );
  } catch {
    return null;
  }
}
