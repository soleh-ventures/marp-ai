// Mid-onboarding abandonment nudge (design finding 5 — one gentle nudge at
// ~24h of silence during the preference phase, then STOP; the re-entry recap
// in process-incoming handles them whenever they come back on their own).
//
// Piggybacks on the reminder cron (every 15 min): cheap SQL filter, at most
// one nudge per athlete ever (prefs_nudge_at marker).

import { and, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { athletes } from "../db/schema.js";
import { getAthleticHistory } from "../flows/onboarding.js";
import { getPrefsState } from "../flows/preferences.js";
import { deliver } from "./messaging/deliver.js";

const NUDGE_AFTER_MS = 24 * 60 * 60 * 1000;

const NUDGE_TEXT =
  "Still here — your profile's saved, and you're two taps away from your " +
  "plan. Pick up anytime, exactly where you left off.";

export async function runOnboardingNudges(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - NUDGE_AFTER_MS);
  // SQL-side prefilter (prefs_state present, no nudge marker, silent >24h);
  // precise checks happen in JS on the small remainder.
  const candidates = await db
    .select({
      id: athletes.id,
      athleticHistory: athletes.athleticHistory,
      lastSeenAt: athletes.lastSeenAt,
    })
    .from(athletes)
    .where(
      and(
        isNull(athletes.archivedAt),
        lt(athletes.lastSeenAt, cutoff),
        sql`${athletes.athleticHistory} ? 'prefs_state'`,
        sql`NOT (${athletes.athleticHistory} ? 'prefs_nudge_at')`,
      ),
    );

  let sent = 0;
  for (const c of candidates) {
    const history = getAthleticHistory(c.athleticHistory);
    const state = getPrefsState(history);
    if (!state || state === "done") continue;
    // Mark FIRST so a crash between mark and send costs one nudge, never a
    // daily repeat.
    await db
      .update(athletes)
      .set({
        athleticHistory: { ...history, prefs_nudge_at: now.toISOString() },
      })
      .where(sql`${athletes.id} = ${c.id}`);
    try {
      await deliver(c.id, NUDGE_TEXT);
      console.log(`evt=onboarding_nudge athlete=${c.id}`);
      sent++;
    } catch (err) {
      console.error("onboarding nudge send failed:", (err as Error).message);
    }
  }
  return sent;
}
