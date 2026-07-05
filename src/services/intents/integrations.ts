// Integrations intents — the honest menu (Strava offer removed; Garmin is
// founder-only today, so athlete interest becomes a real demand signal for
// the source-agnostic ingestion track instead of a placebo button).

import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { athletes } from "../../db/schema.js";
import { getAthleticHistory } from "../../flows/onboarding.js";

const GARMIN_PATTERNS = [
  /\bgarmin\b/i,
  /connect\b.{0,20}\bwatch\b/i,
];

export function looksLikeGarminConnect(message: string): boolean {
  const t = message.trim();
  if (t.length > 80) return false;
  return GARMIN_PATTERNS.some((re) => re.test(t));
}

export const GARMIN_WAITLIST_REPLY =
  "⌚ Garmin sync isn't live for athletes yet — you're on the waitlist. " +
  "The moment it ships, I'll ping you and your runs flow in automatically.\n" +
  "Until then: send a GPX after a run, or just tell me how it went.";

export const GARMIN_ALREADY_WAITLISTED_REPLY =
  "You're already on the Garmin waitlist — I'll ping you the day it's live. " +
  "GPX files and check-ins keep working meanwhile.";

// Record the tap/ask. Returns the right reply either way.
export async function recordGarminInterest(athleteId: string): Promise<string> {
  const [row] = await db
    .select({ athleticHistory: athletes.athleticHistory })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  if (!row) return GARMIN_WAITLIST_REPLY;
  const history = getAthleticHistory(row.athleticHistory);
  if (typeof history.garmin_waitlist_at === "string") {
    return GARMIN_ALREADY_WAITLISTED_REPLY;
  }
  await db
    .update(athletes)
    .set({
      athleticHistory: { ...history, garmin_waitlist_at: new Date().toISOString() },
    })
    .where(eq(athletes.id, athleteId));
  console.log(`evt=garmin_waitlist athlete=${athleteId}`);
  return GARMIN_WAITLIST_REPLY;
}
