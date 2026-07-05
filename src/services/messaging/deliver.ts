// Channel router: one place that decides whether a message goes out over
// WhatsApp (Twilio) or Telegram, based on config.messaging.channel and what
// contact ids the athlete has. Callers persist the message row themselves and
// record the returned channel + provider id.
//
// WhatsApp stays fully functional — set MESSAGING_CHANNEL=whatsapp (default).
// MESSAGING_CHANNEL=telegram turns WhatsApp off (routing-wise) without deleting
// any of its code.
//
// Choices: a message may carry a closed question (inline keyboard on Telegram,
// numbered-text fallback on WhatsApp or when CHOICES_UI=text). The RENDERED
// body — what the athlete actually saw, fallback suffix included — is returned
// so the caller persists that, keeping lastOutbound signature checks honest
// (eng amendment 4).

import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { athletes } from "../../db/schema.js";
import { sendWhatsApp } from "../twilio-send.js";
import { sendTelegram } from "./telegram-send.js";
import {
  buildInlineKeyboard,
  renderTextFallback,
  type ChoiceQuestion,
} from "./choices.js";

export type Channel = "whatsapp" | "telegram";
export type DeliverResult = {
  channel: Channel;
  providerMessageId: string; // Twilio SID (whatsapp) or Telegram message id
  // What was actually sent (text fallback appended when buttons weren't used).
  renderedBody: string;
  // True when an inline keyboard is live on the sent message — the caller
  // records providerMessageId as the keyboard to retire on answer.
  keyboardSent: boolean;
};

type Contact = { phone: string | null; telegramChatId: string | null };

// Which channel to use. "telegram"/"whatsapp" force it (and no-op if that
// channel's id is missing); "both" prefers Telegram when a chat id exists.
export function resolveChannel(a: Contact): Channel | null {
  const mode = config.messaging.channel;
  if (mode === "telegram") return a.telegramChatId ? "telegram" : null;
  if (mode === "whatsapp") return a.phone ? "whatsapp" : null;
  if (a.telegramChatId) return "telegram";
  if (a.phone) return "whatsapp";
  return null;
}

export async function deliver(
  athleteId: string,
  body: string,
  opts?: { choices?: ChoiceQuestion },
): Promise<DeliverResult | null> {
  const [a] = await db
    .select({ phone: athletes.phone, telegramChatId: athletes.telegramChatId })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  if (!a) return null;

  const channel = resolveChannel(a);
  if (!channel) return null;

  const question = opts?.choices;
  // Buttons only on Telegram and only when the kill switch allows them.
  const useButtons =
    channel === "telegram" && !!question && config.messaging.choicesUi === "buttons";
  const renderedBody =
    question && !useButtons ? body + renderTextFallback(question) : body;

  if (channel === "telegram" && a.telegramChatId) {
    const r = await sendTelegram(a.telegramChatId, renderedBody, {
      replyMarkup: useButtons && question ? buildInlineKeyboard(question) : undefined,
    });
    return {
      channel,
      providerMessageId: r.telegramMessageId,
      renderedBody,
      keyboardSent: useButtons && !r.markupDropped,
    };
  }
  if (channel === "whatsapp" && a.phone) {
    const r = await sendWhatsApp(a.phone, renderedBody);
    return {
      channel,
      providerMessageId: r.twilioMessageSid,
      renderedBody,
      keyboardSent: false,
    };
  }
  return null;
}
