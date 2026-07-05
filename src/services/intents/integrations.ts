// Integrations intents — the honest menu (Strava offer removed; Garmin is
// founder-only today, so athlete interest becomes a real demand signal for
// the source-agnostic ingestion track instead of a placebo button).

import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../../db/client.js";
import { athletes, garminWellness } from "../../db/schema.js";
import { getAthleticHistory } from "../../flows/onboarding.js";

// ONLY explicit connect/link/setup intent — NOT any mention of "garmin".
// A bare /garmin/ match hijacked "pull my garmin data" / "analyze my garmin
// run" with the canned connect reply, so those never reached the coach (who
// has the athlete's activities + readiness in context and can actually answer).
const GARMIN_CONNECT_PATTERNS = [
  /\b(connect|link|set\s?up|pair|hook\s?up|integrate|add)\b.{0,20}\bgarmin\b/i,
  /\bgarmin\b.{0,15}\b(connect|link|set\s?up|setup|pair|integration)\b/i,
  /\bconnect\b.{0,20}\bwatch\b/i,
];

export function looksLikeGarminConnect(message: string): boolean {
  const t = message.trim();
  if (t.length > 80) return false;
  return GARMIN_CONNECT_PATTERNS.some((re) => re.test(t));
}

export const GARMIN_WAITLIST_REPLY =
  "⌚ Garmin sync isn't live for athletes yet — you're on the waitlist. " +
  "The moment it ships, I'll ping you and your runs flow in automatically.\n" +
  "Until then: send a GPX after a run, or just tell me how it went.";

export const GARMIN_ALREADY_WAITLISTED_REPLY =
  "You're already on the Garmin waitlist — I'll ping you the day it's live. " +
  "GPX files and check-ins keep working meanwhile.";

export const GARMIN_ALREADY_CONNECTED_REPLY =
  "⌚ Your Garmin's already connected — I'm reading your sleep, resting HR, " +
  "body battery and readiness every morning, and I factor it into how hard I " +
  "push you. Nothing more to do.";

// An athlete counts as "Garmin connected" when the recovery sidecar has
// landed recent wellness rows for them. Cheap single-row existence check.
async function hasRecentGarminData(athleteId: string): Promise<boolean> {
  const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const [row] = await db
    .select({ date: garminWellness.date })
    .from(garminWellness)
    .where(
      and(eq(garminWellness.athleteId, athleteId), gte(garminWellness.date, since)),
    )
    .orderBy(desc(garminWellness.date))
    .limit(1);
  return Boolean(row);
}

// Record the tap/ask. Returns the right reply:
//   - data already flowing (founder via the sidecar) → "already connected"
//   - already waitlisted → the reminder
//   - otherwise → waitlist + stamp the demand signal
export async function recordGarminInterest(athleteId: string): Promise<string> {
  const [row] = await db
    .select({ athleticHistory: athletes.athleticHistory })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  if (!row) return GARMIN_WAITLIST_REPLY;
  const history = getAthleticHistory(row.athleticHistory);

  // Connected-check comes FIRST: an athlete whose watch data is already
  // ingesting must never be told they're on a waitlist. Self-heals a stale
  // garmin_waitlist_at flag if the sidecar started flowing later.
  if (await hasRecentGarminData(athleteId)) {
    if (typeof history.garmin_waitlist_at === "string") {
      const { garmin_waitlist_at: _drop, ...rest } = history;
      await db
        .update(athletes)
        .set({ athleticHistory: rest })
        .where(eq(athletes.id, athleteId));
    }
    return GARMIN_ALREADY_CONNECTED_REPLY;
  }

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
