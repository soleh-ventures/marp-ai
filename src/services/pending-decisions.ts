import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { pendingDecisions } from "../db/schema.js";
import type { DecisionFrame } from "../router/types.js";

// ET8 service layer for pending_decisions rows.
//
// Two operations are needed in the binder chain:
//
//   recordFrame(athleteId, messageId, frame)
//     Called from process-incoming after the outbound message that
//     contained the decision_frame is persisted. The outbound message_id
//     is the back-pointer used by the binder (ET7) to find the most
//     recent open frame for an athlete.
//
//   getOpenFrames(athleteId, limit?)
//     Called by the binder before/during reply processing. Returns the
//     athlete's open decision frames newest-first so the binder can try
//     to match the runner's reply against the most-recent first.
//
// The "open" filter (resolved_at IS NULL) lines up with the partial
// index pending_decisions_unresolved_idx — Postgres can serve this
// without scanning resolved rows.

export type PendingDecisionRow = typeof pendingDecisions.$inferSelect;

export async function recordFrame(
  athleteId: string,
  outboundMessageId: string | null,
  frame: DecisionFrame,
): Promise<PendingDecisionRow> {
  const [row] = await db
    .insert(pendingDecisions)
    .values({
      athleteId,
      messageId: outboundMessageId,
      frame,
    })
    .returning();
  if (!row) throw new Error("recordFrame: insert returned no row");
  return row;
}

// How many recent open frames to consider when binding a runner's reply.
// In practice 1 is the common case (MARP just asked, runner just answered);
// but if the runner skips a question and answers an earlier one, we want
// the binder to see those too. 5 is plenty without ballooning the LLM
// payload when the free-form binder needs it.
const OPEN_FRAMES_DEFAULT_LIMIT = 5;

export async function getOpenFrames(
  athleteId: string,
  limit: number = OPEN_FRAMES_DEFAULT_LIMIT,
): Promise<PendingDecisionRow[]> {
  return await db
    .select()
    .from(pendingDecisions)
    .where(
      and(
        eq(pendingDecisions.athleteId, athleteId),
        isNull(pendingDecisions.resolvedAt),
      ),
    )
    .orderBy(desc(pendingDecisions.createdAt))
    .limit(limit);
}
