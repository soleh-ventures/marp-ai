import { Hono } from "hono";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { messages } from "../db/schema.js";
import { findOrCreateByTelegramChatId } from "../services/athletes.js";
import { claimMessage } from "../services/idempotency.js";
import { processIncomingMessage } from "../services/process-incoming.js";

export const telegramWebhook = new Hono();

// Fire-and-forget handle so tests can await background work before teardown
// (mirrors the Twilio webhook). Entries clear as promises settle.
const inFlight: Set<Promise<unknown>> = new Set();
export function pendingTelegramWork(): Promise<unknown> {
  return Promise.allSettled([...inFlight]);
}

// Minimal shape of a Telegram update we care about (a text message).
type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number };
  };
};

telegramWebhook.post("/", async (c) => {
  // Optional shared secret Telegram echoes on every webhook POST (set via
  // setWebhook's secret_token). Verify when configured; never leak why.
  if (config.telegram.webhookSecret) {
    const got = c.req.header("X-Telegram-Bot-Api-Secret-Token");
    if (got !== config.telegram.webhookSecret) return c.text("forbidden", 403);
  }

  const update = (await c.req.json().catch(() => ({}))) as TelegramUpdate;
  const msg = update.message;
  const chatId = msg?.chat?.id;
  const text = msg?.text;
  // Only text messages drive the coach. Ack everything else (edits, joins,
  // callbacks) with 200 so Telegram doesn't retry.
  if (chatId === undefined || !text) return c.json({ ok: true });

  // Idempotency: Telegram retries on non-200. Claim on update_id so a retry
  // of an already-handled update is a silent no-op.
  const claimKey = `tg-${update.update_id ?? `${chatId}-${msg?.message_id}`}`;
  const fresh = await claimMessage(claimKey);
  if (!fresh) return c.json({ ok: true });

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
  if (!inserted) return c.text("internal", 500);

  // Ack immediately, run the brain + reply in the background (same pattern as
  // Twilio). The reply routes back to Telegram via the channel router. No
  // media / inbound-SID for Telegram, and no native typing indicator.
  const task = processIncomingMessage(
    athlete.id,
    inserted.id,
    text,
    null,
    null,
    null,
    [],
  )
    .catch((err) => {
      console.error("processIncoming (telegram) failed:", err);
    })
    .finally(() => {
      inFlight.delete(task);
    });
  inFlight.add(task);

  return c.json({ ok: true });
});
