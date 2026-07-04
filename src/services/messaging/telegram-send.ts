// Telegram Bot API sender — the WhatsApp-free channel for personal use.
// Mirrors twilio-send.ts: split long bodies, send parts in order, return the
// first message id. No Twilio, no templates, no business verification.

import { config } from "../../config.js";

const TELEGRAM_LIMIT = 4096; // Telegram's per-message character cap

export type SendTelegramResult = { telegramMessageId: string };

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

async function sendOne(token: string, chatId: string, text: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: { message_id: number };
    description?: string;
  };
  if (!res.ok || !data.ok || !data.result) {
    throw new Error(
      `Telegram sendMessage failed: ${res.status} ${data.description ?? ""}`.trim(),
    );
  }
  return String(data.result.message_id);
}

export async function sendTelegram(
  chatId: string,
  body: string,
): Promise<SendTelegramResult> {
  const token = config.telegram.botToken;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN must be set to send Telegram messages");
  }
  const parts = splitForTelegram(body);
  let firstId: string | undefined;
  for (const part of parts) {
    const id = await sendOne(token, chatId, part);
    if (firstId === undefined) firstId = id;
  }
  return { telegramMessageId: firstId ?? "" };
}
