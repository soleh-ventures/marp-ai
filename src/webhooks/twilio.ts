import { Hono } from "hono";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { messages } from "../db/schema.js";
import { findOrCreateByPhone } from "../services/athletes.js";
import { claimMessage } from "../services/idempotency.js";
import { processIncomingMessage } from "../services/process-incoming.js";
import { verifySignature } from "../services/twilio-signature.js";

export const twilioWebhook = new Hono();

// Tracks fire-and-forget background processing so tests can await all
// in-flight work before tearing down (prevents FK races against
// per-test TRUNCATE). In prod, entries are removed as soon as the
// promise settles — it's effectively a debug handle.
const inFlight: Set<Promise<unknown>> = new Set();

export function pendingBackgroundWork(): Promise<unknown> {
  return Promise.allSettled([...inFlight]);
}

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
  // Kill switch: when the app is Telegram-only, WhatsApp inbound is fully
  // disabled — no user can chat via WhatsApp. Ack with empty TwiML so Twilio
  // stops retrying, but do NOT process, create an athlete, or reply.
  if (config.messaging.channel === "telegram") {
    return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });
  }

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
  // `from` is the runner's WhatsApp phone. PII — never log it directly.
  // Use the athlete UUID once findOrCreateByPhone resolves, or
  // redactPhone() from services/phone-redact for pre-resolve sites.
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

  // Twilio numbers media MediaUrl0..N. Collect ALL of them so a plan split
  // across several photos / files is read together. mediaUrl (the first) is
  // still stored on the message row + used by the fitness-file fast path.
  const numMedia = Number(params.NumMedia ?? "0");
  const allMedia: { url: string; contentType?: string }[] = [];
  for (let i = 0; i < numMedia; i++) {
    const u = params[`MediaUrl${i}`];
    if (u) allMedia.push({ url: u, contentType: params[`MediaContentType${i}`] });
  }
  const mediaUrl = allMedia[0]?.url ?? null;

  const [inserted] = await db
    .insert(messages)
    .values({
      athleteId: athlete.id,
      direction: "in",
      body: bodyText,
      mediaUrl,
      twilioMessageSid: sid,
    })
    .returning({ id: messages.id });
  if (!inserted) {
    return c.text("internal", 500);
  }

  // Fire and forget: ack to Twilio immediately, run the brain + reply
  // in the background. Twilio's webhook timeout is 15s but multi-domain
  // routing can be ~25s — synchronous reply isn't an option. Errors are
  // logged; the runner just doesn't see a reply, which is recoverable
  // (they'll re-engage, we'll see it in the log).
  //
  // The native WhatsApp "typing…" indicator fires from process-incoming's
  // LLM-bound branches (referencing this inbound SID) — immediate, and
  // suppressed on fast paths (consent / dormancy / file-ingest /
  // Strava-connect / deletion) where the reply lands quickly.
  const task = processIncomingMessage(
    athlete.id,
    inserted.id,
    bodyText,
    mediaUrl,
    allMedia[0]?.contentType ?? null,
    // Pass the inbound Twilio SID so the LLM-bound branches can show the
    // native WhatsApp "typing…" indicator (referencing this message).
    sid,
    // All attachments, so a multi-file plan upload is read together.
    allMedia,
  )
    .catch((err) => {
      console.error("processIncoming failed:", err);
    })
    .finally(() => {
      inFlight.delete(task);
    });
  inFlight.add(task);

  return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });
});
