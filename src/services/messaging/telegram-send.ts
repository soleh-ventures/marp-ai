// Telegram Bot API sender — the WhatsApp-free channel for personal use.
// Mirrors twilio-send.ts: split long bodies, send parts in order. With an
// inline keyboard the markup rides the LAST chunk (buttons belong under the
// question, not a truncated intro) and the returned id is THAT chunk's id —
// it's what editMessageReplyMarkup needs to retire the keyboard later.

import { config } from "../../config.js";

const TELEGRAM_LIMIT = 4096; // Telegram's per-message character cap

export type TelegramReplyMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

export type SendTelegramResult = {
  // The id that matters downstream: the markup chunk's id when a keyboard was
  // sent, else the first chunk's id (back-compat with existing callers).
  telegramMessageId: string;
  // True when the keyboard send got a 400 and we fell back to plain text —
  // the caller should have included a text fallback in the body already.
  markupDropped: boolean;
};

// Split on a newline near the limit when possible, else hard-cut.
export function splitForTelegram(body: string): string[] {
  if (body.length <= TELEGRAM_LIMIT) return [body];
  const parts: string[] = [];
  let rest = body;
  while (rest.length > TELEGRAM_LIMIT) {
    let cut = rest.lastIndexOf("\n", TELEGRAM_LIMIT);
    if (cut < TELEGRAM_LIMIT * 0.5) cut = TELEGRAM_LIMIT; // no good break — hard-cut
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

class TelegramApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function sendOne(
  token: string,
  chatId: string,
  text: string,
  replyMarkup?: TelegramReplyMarkup,
): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: { message_id: number };
    description?: string;
  };
  if (!res.ok || !data.ok || !data.result) {
    throw new TelegramApiError(
      res.status,
      `Telegram sendMessage failed: ${res.status} ${data.description ?? ""}`.trim(),
    );
  }
  return String(data.result.message_id);
}

export async function sendTelegram(
  chatId: string,
  body: string,
  opts?: { replyMarkup?: TelegramReplyMarkup },
): Promise<SendTelegramResult> {
  const token = config.telegram.botToken;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN must be set to send Telegram messages");
  }
  const parts = splitForTelegram(body);
  let firstId: string | undefined;
  let markupId: string | undefined;
  let markupDropped = false;

  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const markup = isLast ? opts?.replyMarkup : undefined;
    let id: string;
    try {
      id = await sendOne(token, chatId, parts[i]!, markup);
    } catch (err) {
      // Eng amendment: a 400 with markup (malformed keyboard, cap breach)
      // must degrade to a plain-text send, never a lost question. The body
      // already carries the numbered-text fallback when choices are attached
      // (deliver renders it), so a markup-less resend still works.
      if (markup && err instanceof TelegramApiError && err.status === 400) {
        console.error(`telegram: markup send 400, retrying plain — ${err.message}`);
        id = await sendOne(token, chatId, parts[i]!);
        markupDropped = true;
      } else {
        throw err;
      }
    }
    if (firstId === undefined) firstId = id;
    if (isLast && opts?.replyMarkup && !markupDropped) markupId = id;
  }

  return {
    telegramMessageId: markupId ?? firstId ?? "",
    markupDropped,
  };
}

// Retire a keyboard after its question is answered so stale taps can't pile
// up. Best-effort: messages older than 48h can't be edited (Telegram 400) —
// that's fine, the pending-question state is the real guard.
export async function removeInlineKeyboard(
  chatId: string,
  messageId: string,
): Promise<void> {
  const token = config.telegram.botToken;
  if (!token || !messageId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: Number(messageId) }),
    });
  } catch (err) {
    console.error("telegram: editMessageReplyMarkup failed", (err as Error).message);
  }
}

// Stop the 30s button spinner. Optional text renders as a toast. Best-effort —
// a failed answer just means the spinner self-clears.
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  const token = config.telegram.botToken;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      }),
    });
  } catch (err) {
    console.error("telegram: answerCallbackQuery failed", (err as Error).message);
  }
}
