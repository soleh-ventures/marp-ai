import { Hono } from "hono";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { messages } from "../db/schema.js";
import { findOrCreateByPhone } from "../services/athletes.js";
import { claimMessage } from "../services/idempotency.js";
import { verifySignature } from "../services/twilio-signature.js";

export const twilioWebhook = new Hono();

// Empty TwiML response — tells Twilio we've accepted the message but won't
// send a synchronous reply. The expert-router will reply async via the
// Twilio REST API (T5). Returning an empty <Response> is the canonical way
// to ack without responding inline.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

// Reconstruct the URL Twilio used to sign the request. Hono's c.req.url is
// authoritative when the app is hit directly. Behind a proxy (Railway, ngrok)
// we honour an explicit override so the signature math works.
function signedUrl(reqUrl: string): string {
  if (config.twilio.publicWebhookBase) {
    const u = new URL(reqUrl);
    return config.twilio.publicWebhookBase.replace(/\/$/, "") + u.pathname + u.search;
  }
  return reqUrl;
}

twilioWebhook.post("/whatsapp", async (c) => {
  // Twilio sends application/x-www-form-urlencoded. Hono parses it via parseBody.
  const body = await c.req.parseBody();
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string") params[k] = v;
  }

  const signature = c.req.header("X-Twilio-Signature");
  if (!config.twilio.skipSignature) {
    const ok = verifySignature(
      config.twilio.authToken,
      signature ?? null,
      signedUrl(c.req.url),
      params,
    );
    if (!ok) {
      // 403 + empty body — never leak why it failed.
      return c.text("forbidden", 403);
    }
  }

  const sid = params.MessageSid;
  const from = params.From;
  const bodyText = params.Body ?? "";
  if (!sid || !from) {
    return c.text("bad request", 400);
  }

  const fresh = await claimMessage(sid);
  if (!fresh) {
    // Twilio retried a delivery we already handled. Ack silently — never
    // double-process and never reply twice.
    return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });
  }

  const athlete = await findOrCreateByPhone(from);

  const numMedia = Number(params.NumMedia ?? "0");
  const mediaUrl = numMedia > 0 ? (params.MediaUrl0 ?? null) : null;

  await db.insert(messages).values({
    athleteId: athlete.id,
    direction: "in",
    body: bodyText,
    mediaUrl,
    twilioMessageSid: sid,
  });

  return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });
});
