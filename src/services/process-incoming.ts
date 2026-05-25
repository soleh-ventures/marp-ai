import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { athletes, messages } from "../db/schema.js";
import { getMemoryContext } from "../memory/retrieve.js";
import { route } from "../router/index.js";
import { sendWhatsApp, TwilioSendError } from "./twilio-send.js";

// Fired from the webhook AFTER we've returned 200 to Twilio. Pulls
// memory → routes through the brain → sends the reply → persists the
// outbound message row. Runs detached; errors here don't crash the
// request (the runner just doesn't get a reply, which they'd notice).

export async function processIncomingMessage(
  athleteId: string,
  messageId: string,
  body: string,
): Promise<void> {
  // Pull the runner's phone — needed to address the outbound message.
  // Could thread it through from the webhook to save the lookup, but
  // doing it here keeps the contract tight: ids in, side effects done.
  const athleteRow = (
    await db
      .select({ phone: athletes.phone })
      .from(athletes)
      .where(eq(athletes.id, athleteId))
      .limit(1)
  )[0];
  if (!athleteRow) {
    console.error(`processIncoming: athlete ${athleteId} not found, dropping reply`);
    return;
  }

  // Memory + routing. The router persists every LLM call into llm_calls
  // so we don't need to do anything extra for cost tracking.
  const memory = await getMemoryContext(athleteId);
  const result = await route({
    message: body,
    athleteId,
    messageId,
    contextSummary: memory.text,
  });

  const replyText = result.finalText.trim();
  if (!replyText) {
    console.error(`processIncoming: empty reply for message ${messageId}`);
    return;
  }

  // Send via Twilio. If the API rejects (bad number, sandbox not
  // joined, rate limit), log and keep going — the inbound message is
  // already persisted, no rollback needed.
  let outboundSid: string | undefined;
  try {
    const sendResult = await sendWhatsApp(athleteRow.phone, replyText);
    outboundSid = sendResult.twilioMessageSid;
  } catch (err) {
    if (err instanceof TwilioSendError) {
      console.error(
        `Twilio send failed (${err.status}): ${err.body.slice(0, 200)}`,
      );
    } else {
      console.error("Twilio send threw:", (err as Error).message);
    }
    return;
  }

  // Persist the outbound message for the next turn's memory retrieval.
  await db.insert(messages).values({
    athleteId,
    direction: "out",
    body: replyText,
    twilioMessageSid: outboundSid,
  });
}
