import { config } from "../config.js";

// Twilio outbound — raw fetch instead of the SDK. The REST API is two
// fields (To, From, Body) over basic auth; pulling in the whole twilio
// npm package would mostly add ceremony.
//
// Reference: https://www.twilio.com/docs/messaging/api/message-resource

export type SendWhatsAppResult = {
  // The SID Twilio assigned to the OUTBOUND message — opaque, useful for
  // future "did Twilio actually deliver this?" lookups against their API.
  twilioMessageSid: string;
};

export class TwilioSendError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "TwilioSendError";
  }
}

/**
 * Send a WhatsApp message via Twilio's REST API.
 *
 * @param toE164 — recipient phone number in E.164 (e.g. "+4917628950549").
 *                The "whatsapp:" prefix is added automatically.
 * @param body  — message body. Twilio's limit is 1600 chars per WhatsApp
 *                message; we cap conservatively at 1500 and let the
 *                caller decide whether to split.
 */
export async function sendWhatsApp(
  toE164: string,
  body: string,
): Promise<SendWhatsAppResult> {
  const sid = config.twilio.accountSid;
  const token = config.twilio.authToken;
  const from = config.twilio.whatsappFrom;
  if (!sid || !token) {
    throw new Error(
      "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set to send WhatsApp messages",
    );
  }

  const trimmed = body.length > 1500 ? `${body.slice(0, 1497)}...` : body;
  const params = new URLSearchParams({
    To: toE164.startsWith("whatsapp:") ? toE164 : `whatsapp:${toE164}`,
    From: from,
    Body: trimmed,
  });
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new TwilioSendError(
      `Twilio send failed (${res.status})`,
      res.status,
      text.slice(0, 500),
    );
  }
  let parsed: { sid?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TwilioSendError("Twilio send: non-JSON response", res.status, text);
  }
  if (!parsed.sid) {
    throw new TwilioSendError(
      "Twilio send: response missing sid",
      res.status,
      text.slice(0, 500),
    );
  }
  return { twilioMessageSid: parsed.sid };
}
