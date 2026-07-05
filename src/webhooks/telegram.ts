import { Hono } from "hono";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { messages } from "../db/schema.js";
import { getAthleticHistory } from "../flows/onboarding.js";
import { findOrCreateByTelegramChatId } from "../services/athletes.js";
import { claimMessage } from "../services/idempotency.js";
import { decodeCallback } from "../services/messaging/choices.js";
import {
  getPendingChoice,
  resolvePendingChoice,
} from "../services/messaging/pending-choice.js";
import { enqueueForAthlete } from "../services/messaging/serialize.js";
import { answerCallbackQuery } from "../services/messaging/telegram-send.js";
import { processIncomingMessage } from "../services/process-incoming.js";

export const telegramWebhook = new Hono();

// Fire-and-forget handle so tests can await background work before teardown
// (mirrors the Twilio webhook). Entries clear as promises settle.
const inFlight: Set<Promise<unknown>> = new Set();
export function pendingTelegramWork(): Promise<unknown> {
  return Promise.allSettled([...inFlight]);
}

function track(task: Promise<unknown>): void {
  inFlight.add(task);
  const done = () => inFlight.delete(task);
  task.then(done, done);
}

// Minimal shape of the Telegram updates we care about.
type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number };
  };
  callback_query?: {
    id?: string;
    data?: string;
    message?: { message_id?: number; chat?: { id?: number } };
  };
};

// Toast copy for taps that can't apply. Short — Telegram toasts truncate.
const TOAST_EXPIRED = "That menu has expired — just type your answer.";
const TOAST_STALE = "Already answered ✓";

telegramWebhook.post("/", async (c) => {
  // Optional shared secret Telegram echoes on every webhook POST (set via
  // setWebhook's secret_token). Verify when configured; never leak why.
  // (config.ts hard-requires it in prod Telegram mode — see
  // _assertTelegramSecurity.)
  if (config.telegram.webhookSecret) {
    const got = c.req.header("X-Telegram-Bot-Api-Secret-Token");
    if (got !== config.telegram.webhookSecret) return c.text("forbidden", 403);
  }

  const update = (await c.req.json().catch(() => ({}))) as TelegramUpdate;

  // ── Button tap (callback_query) ─────────────────────────────────────
  // A tap decodes to a canonical text value and runs through the SAME
  // pipeline as a typed message (synthetic: true skips the free-text
  // enrichment LLMs). Idempotency layers:
  //   1. claim on callback_query.id — dedupes Telegram REDELIVERY only
  //      (every physical tap has a fresh id)
  //   2. pending_choice state — the real double-tap guard: first tap
  //      clears it, second tap sees no match → stale toast
  const cb = update.callback_query;
  if (cb?.id && cb.data !== undefined) {
    const cbChatId = cb.message?.chat?.id;
    if (cbChatId === undefined) {
      void answerCallbackQuery(cb.id, TOAST_EXPIRED);
      return c.json({ ok: true });
    }
    const fresh = await claimMessage(`tg-cb-${cb.id}`);
    if (!fresh) return c.json({ ok: true });

    const decoded = decodeCallback(cb.data);
    if (!decoded) {
      // Unknown version / foreign data — old buttons from before a deploy.
      void answerCallbackQuery(cb.id, TOAST_EXPIRED);
      return c.json({ ok: true });
    }

    const task = enqueueForAthlete(String(cbChatId), async () => {
      const athlete = await findOrCreateByTelegramChatId(String(cbChatId));
      // Fresh read inside the queue — findOrCreate returns the full row.
      const history = getAthleticHistory(athlete.athleticHistory);
      const pending = getPendingChoice(history);
      if (!pending || pending.question_id !== decoded.questionId) {
        void answerCallbackQuery(cb.id!, TOAST_STALE);
        return;
      }
      // Claim the question: clear state + retire the keyboard. Under the
      // per-athlete queue this read-modify-write is race-free.
      await resolvePendingChoice(athlete.id, decoded.questionId);
      void answerCallbackQuery(cb.id!);

      const [inserted] = await db
        .insert(messages)
        .values({
          athleteId: athlete.id,
          direction: "in",
          body: decoded.value,
          channel: "telegram",
        })
        .returning({ id: messages.id });
      if (!inserted) return;

      await processIncomingMessage(
        athlete.id,
        inserted.id,
        decoded.value,
        null,
        null,
        null,
        [],
        // answeredChoiceId: we just cleared pending_choice above, so the
        // gated branches (calib/caloffer/gcaldis) need the tapped question id
        // to match — pending_choice is already gone.
        { synthetic: true, answeredChoiceId: decoded.questionId },
      ).catch((err) => {
        console.error("evt=callback_error processing failed:", err);
      });
    });
    track(task);
    return c.json({ ok: true });
  }

  // ── Plain text message ──────────────────────────────────────────────
  const msg = update.message;
  const chatId = msg?.chat?.id;
  const text = msg?.text;
  // Only text messages drive the coach. Ack everything else (edits, joins)
  // with 200 so Telegram doesn't retry.
  if (chatId === undefined || !text) return c.json({ ok: true });

  // Idempotency: Telegram retries on non-200. Claim on update_id so a retry
  // of an already-handled update is a silent no-op.
  const claimKey = `tg-${update.update_id ?? `${chatId}-${msg?.message_id}`}`;
  const fresh = await claimMessage(claimKey);
  if (!fresh) return c.json({ ok: true });

  // Ack immediately, run the brain + reply in the background (same pattern as
  // Twilio) — serialized per athlete so a tap and a typed message arriving
  // together can't race each other's athleticHistory writes.
  const task = enqueueForAthlete(String(chatId), async () => {
    const athlete = await findOrCreateByTelegramChatId(String(chatId));

    const [inserted] = await db
      .insert(messages)
      .values({
        athleteId: athlete.id,
        direction: "in",
        body: text,
        channel: "telegram",
      })
      .returning({ id: messages.id });
    if (!inserted) return;

    await processIncomingMessage(
      athlete.id,
      inserted.id,
      text,
      null,
      null,
      null,
      [],
    ).catch((err) => {
      console.error("processIncoming (telegram) failed:", err);
    });
  });
  track(task);

  return c.json({ ok: true });
});
