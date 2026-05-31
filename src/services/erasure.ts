import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { athletes } from "../db/schema.js";

// GDPR Article 17 erasure for a single runner.
//
// Implementation note: every athlete-linked table has the right FK
// behaviour on delete already — race_blocks, activities, active_flags,
// messages, strava_connections all CASCADE; llm_calls uses SET NULL so
// the cost telemetry survives anonymised (it stores no message bodies,
// only token counts + model + latency). So one DELETE on `athletes`
// fans out correctly.
//
// Out of scope for v1: processed_messages dedup rows (keyed by Twilio
// MessageSid, opaque without Twilio account access — orphaned-but-
// harmless after the linked athlete/messages cascade). Revisit if a
// legal request requires those too.

export type EraseResult = {
  athleteId: string;
  deleted: boolean;
};

export async function deleteAthlete(
  athleteId: string,
): Promise<EraseResult> {
  const result = await db
    .delete(athletes)
    .where(eq(athletes.id, athleteId))
    .returning({ id: athletes.id });
  return {
    athleteId,
    deleted: result.length > 0,
  };
}
