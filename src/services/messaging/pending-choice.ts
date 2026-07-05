// Pending-question state — the server-side truth for "which closed question
// is open right now". This, not callback_query.id claiming, is what makes
// double-taps idempotent: every physical tap carries a FRESH callback id, so
// the second tap must lose against state, not against an idempotency key
// (eng amendment 1).
//
// Lives in athletes.athleticHistory.pending_choice. Reads/writes assume the
// per-athlete serialization in the webhook layer (serialize.ts) — with all of
// an athlete's inbounds processed one at a time on a single instance, a plain
// read-modify-write cannot lose updates.

import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { athletes } from "../../db/schema.js";
import type { AthleticHistory } from "../../flows/onboarding.js";
import { getAthleticHistory } from "../../flows/onboarding.js";
import { removeInlineKeyboard } from "./telegram-send.js";

export type PendingChoice = {
  question_id: string;
  // Telegram message id carrying the live keyboard (null on WhatsApp/text
  // mode). Needed to retire the keyboard once the question is answered.
  tg_message_id: string | null;
  asked_at: string;
};

export function getPendingChoice(history: AthleticHistory): PendingChoice | null {
  const pc = history.pending_choice as PendingChoice | undefined;
  if (pc && typeof pc === "object" && typeof pc.question_id === "string") return pc;
  return null;
}

// Fresh read-modify-write: the branch logic may have rewritten athleticHistory
// earlier in the same turn, so never write a stale in-memory copy.
export async function setPendingChoice(
  athleteId: string,
  pc: PendingChoice | null,
): Promise<void> {
  const [row] = await db
    .select({ athleticHistory: athletes.athleticHistory })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  if (!row) return;
  const history = getAthleticHistory(row.athleticHistory);
  const next: AthleticHistory = { ...history };
  if (pc) next.pending_choice = pc;
  else delete next.pending_choice;
  await db
    .update(athletes)
    .set({ athleticHistory: next })
    .where(eq(athletes.id, athleteId));
}

// Clear the pending question and retire its keyboard (best-effort). Called
// when an answer lands — via tap OR typed text — so stale buttons can't
// double-fire. Returns the cleared pending question, or null if none matched.
export async function resolvePendingChoice(
  athleteId: string,
  questionId: string,
): Promise<PendingChoice | null> {
  const [row] = await db
    .select({
      athleticHistory: athletes.athleticHistory,
      telegramChatId: athletes.telegramChatId,
    })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  if (!row) return null;
  const history = getAthleticHistory(row.athleticHistory);
  const pc = getPendingChoice(history);
  if (!pc || pc.question_id !== questionId) return null;

  const next: AthleticHistory = { ...history };
  delete next.pending_choice;
  await db
    .update(athletes)
    .set({ athleticHistory: next })
    .where(eq(athletes.id, athleteId));

  if (pc.tg_message_id && row.telegramChatId) {
    void removeInlineKeyboard(row.telegramChatId, pc.tg_message_id);
  }
  return pc;
}
