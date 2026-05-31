import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { athletes } from "../db/schema.js";

// Threshold for triggering the dormancy re-auth challenge.
//
// Why 90 days: telcos in most jurisdictions hold a deactivated number
// for 60–90 days before recycling it to a new subscriber. A 90-day gap
// is the point where "still the same person returning" becomes less
// likely than "the number was reassigned." Shorter would create false
// positives (vacation, exam season). Longer would miss the window
// during which a recycled-number user starts texting us.
export const DORMANCY_THRESHOLD_DAYS = 90;
const DORMANCY_THRESHOLD_MS = DORMANCY_THRESHOLD_DAYS * 86_400 * 1000;

export function isDormant(lastSeenAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - lastSeenAt.getTime() > DORMANCY_THRESHOLD_MS;
}

export async function touchLastSeen(athleteId: string): Promise<void> {
  await db
    .update(athletes)
    .set({ lastSeenAt: new Date() })
    .where(eq(athletes.id, athleteId));
}

// Soft-archive an athlete: the row stays for audit purposes (race blocks,
// activities, etc. cascade-deleted only when the row itself goes), but
// the partial unique index excludes archived rows, freeing the phone for
// a brand-new athlete on the next inbound.
//
// Used by the dormancy "NEW" path. Distinct from deleteAthlete (PR #8 /
// GDPR Article 17 erasure) — that one actually removes the data. This
// one preserves it; a returning real-owner could in theory be restored
// by the operator via a manual UPDATE clearing archived_at.
export async function archiveAthlete(athleteId: string): Promise<void> {
  await db
    .update(athletes)
    .set({ archivedAt: new Date() })
    .where(eq(athletes.id, athleteId));
}
