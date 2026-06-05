import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { athletes, llmCalls } from "../db/schema.js";

// GDPR Article 17 erasure for a single runner.
//
// Implementation note: every athlete-linked table has the right FK
// behaviour on delete already — race_blocks, activities, active_flags,
// messages, strava_connections all CASCADE.
//
// llm_calls is special. Its athlete_id/message_id use SET NULL so the
// aggregate cost telemetry (tokens, model, latency, cost) survives
// anonymised — we want "what did the fleet cost last month" to stay
// accurate after a runner leaves. BUT it now also stores input_user +
// output_text for answer-quality debugging, and those hold PII. SET NULL
// alone would leave that PII orphaned and un-erasable. So we explicitly
// NULL the text columns for this athlete's rows before deleting the
// athlete (after which athlete_id is gone and we can't target them).
// Cost columns stay; PII text goes.
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
  // Scrub PII text from this athlete's llm_calls rows first — once the
  // athlete row is gone, athlete_id is SET NULL and we lose the handle.
  await db
    .update(llmCalls)
    .set({ inputUser: null, outputText: null })
    .where(eq(llmCalls.athleteId, athleteId));

  const result = await db
    .delete(athletes)
    .where(eq(athletes.id, athleteId))
    .returning({ id: athletes.id });
  return {
    athleteId,
    deleted: result.length > 0,
  };
}
