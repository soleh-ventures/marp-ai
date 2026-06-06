// S4 (KER-32) — durable safety event log.
//
// One row per Tier-0/1 triage hit: the liability audit trail and the
// signal we use to improve the classifier (and seed S5 eval fixtures).
// Best-effort by contract — a write failure is logged but NEVER allowed
// to affect the runner's reply (especially an emergency response).

import { db } from "../../db/client.js";
import { safetyEvents } from "../../db/schema.js";
import type { SafetyTriage } from "./triage.js";

export async function recordSafetyEvent(
  athleteId: string,
  messageId: string | null,
  triage: SafetyTriage,
  message: string,
): Promise<void> {
  if (triage.tier === "none") return;
  try {
    await db.insert(safetyEvents).values({
      athleteId,
      messageId: messageId ?? null,
      tier: triage.tier,
      category: triage.category,
      reason: triage.reason || null,
      messageExcerpt: message.slice(0, 280),
    });
  } catch (err) {
    console.error("safety event: write failed (non-fatal):", (err as Error).message);
  }
}
