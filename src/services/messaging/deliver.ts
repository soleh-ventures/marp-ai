// Channel router: one place that decides whether a message goes out over
// WhatsApp (Twilio) or Telegram, based on config.messaging.channel and what
// contact ids the athlete has. Callers persist the message row themselves and
// record the returned channel + provider id.
//
// WhatsApp stays fully functional — set MESSAGING_CHANNEL=whatsapp (default).
// MESSAGING_CHANNEL=telegram turns WhatsApp off (routing-wise) without deleting
// any of its code.

import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { athletes } from "../../db/schema.js";
import { sendWhatsApp } from "../twilio-send.js";
import { sendTelegram } from "./telegram-send.js";

export type Channel = "whatsapp" | "telegram";
export type DeliverResult = {
  channel: Channel;
  providerMessageId: string; // Twilio SID (whatsapp) or Telegram message id
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
): Promise<DeliverResult | null> {
  const [a] = await db
    .select({ phone: athletes.phone, telegramChatId: athletes.telegramChatId })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  if (!a) return null;

  const channel = resolveChannel(a);
  if (!channel) return null;

  if (channel === "telegram" && a.telegramChatId) {
    const r = await sendTelegram(a.telegramChatId, body);
    return { channel, providerMessageId: r.telegramMessageId };
  }
  if (channel === "whatsapp" && a.phone) {
    const r = await sendWhatsApp(a.phone, body);
    return { channel, providerMessageId: r.twilioMessageSid };
  }
  return null;
}
