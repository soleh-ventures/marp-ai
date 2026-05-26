import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { athletes, messages } from "../db/schema.js";
import {
  getAthleticHistory,
  isOnboarded,
  runOnboardingTurn,
} from "../flows/onboarding.js";
import { getMemoryContext } from "../memory/retrieve.js";
import { route } from "../router/index.js";
import { sendWhatsApp, TwilioSendError } from "./twilio-send.js";

// Fired from the webhook AFTER we've returned 200 to Twilio. Branches:
//   - Athlete not onboarded → onboarding flow (one LLM call, extracts +
//     updates athletic_history, returns the next question or the
//     wrap-up message)
//   - Athlete onboarded → memory retrieval + expert router
// Then sends the reply via Twilio and persists the outbound row.
// Runs detached; errors here don't crash the request.

export async function processIncomingMessage(
  athleteId: string,
  messageId: string,
  body: string,
): Promise<void> {
  // Pull phone + athletic_history in one query — we need both regardless
  // of which branch we take.
  const athleteRow = (
    await db
      .select({
        phone: athletes.phone,
        athleticHistory: athletes.athleticHistory,
      })
      .from(athletes)
      .where(eq(athletes.id, athleteId))
      .limit(1)
  )[0];
  if (!athleteRow) {
    console.error(`processIncoming: athlete ${athleteId} not found, dropping reply`);
    return;
  }

  const history = getAthleticHistory(athleteRow.athleticHistory);

  let replyText: string;
  if (!isOnboarded(history)) {
    // Onboarding branch. The flow persists the updated athletic_history
    // itself; we just take the reply.
    const onboardingResult = await runOnboardingTurn(
      athleteId,
      messageId,
      body,
    );
    replyText = onboardingResult.reply;
  } else {
    // Normal expert routing branch.
    const memory = await getMemoryContext(athleteId);
    const result = await route({
      message: body,
      athleteId,
      messageId,
      contextSummary: memory.text,
    });
    replyText = result.finalText.trim();
  }

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
