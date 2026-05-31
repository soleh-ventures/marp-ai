import { and, desc, eq } from "drizzle-orm";
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
import {
  buildConnectReply,
  buildOnboardingStravaOffer,
  getStravaConnectStatus,
  looksLikeStravaConnect,
} from "./strava-connect.js";
import { deleteAthlete } from "./erasure.js";
import {
  DELETION_CONFIRMATION_PROMPT,
  DELETION_SUCCESS_MESSAGE,
  isDeletionConfirmation,
  looksLikeDeletionRequest,
} from "./erasure-intent.js";

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

  // ── Deletion intent (GDPR Article 17) ────────────────────────────────
  // Checked BEFORE onboarding/strava/router so a runner can delete their
  // account from any state — including mid-onboarding. Two-phase:
  //   1. Request matches deletion patterns → reply with the confirmation prompt.
  //   2. Confirmation phrase exactly matches AND the previous outbound was
  //      the prompt → execute deletion, send a goodbye message, exit
  //      without persisting the outbound (the athlete row is gone).
  if (isDeletionConfirmation(body)) {
    const lastOutbound = (
      await db
        .select({ body: messages.body })
        .from(messages)
        .where(and(eq(messages.athleteId, athleteId), eq(messages.direction, "out")))
        .orderBy(desc(messages.receivedAt))
        .limit(1)
    )[0];
    if (lastOutbound?.body === DELETION_CONFIRMATION_PROMPT) {
      const phone = athleteRow.phone;
      await deleteAthlete(athleteId);
      // sendWhatsApp doesn't touch the DB — safe to call after the row's
      // gone. We deliberately don't persist this outbound either.
      sendWhatsApp(phone, DELETION_SUCCESS_MESSAGE).catch((err) =>
        console.error("erasure: goodbye send failed", err),
      );
      return;
    }
    // "YES DELETE" without a preceding prompt — fall through to normal
    // routing (some runner just happened to type that phrase).
  }

  const history = getAthleticHistory(athleteRow.athleticHistory);

  let replyText: string;
  if (looksLikeDeletionRequest(body)) {
    // First-phase deletion request — reply with the confirmation prompt
    // regardless of onboarding state. The deletion-confirmation branch
    // above will catch the follow-up.
    replyText = DELETION_CONFIRMATION_PROMPT;
  } else if (!isOnboarded(history)) {
    // Onboarding branch. The flow persists the updated athletic_history
    // itself; we just take the reply.
    const onboardingResult = await runOnboardingTurn(
      athleteId,
      messageId,
      body,
    );
    replyText = onboardingResult.reply;

    // When onboarding wraps up this turn, append a Strava connect offer
    // so the runner can link their account right away.
    if (onboardingResult.finishedThisTurn) {
      const offer = await buildOnboardingStravaOffer(athleteId).catch(() => null);
      if (offer) replyText += offer;
    }
  } else if (looksLikeStravaConnect(body)) {
    // Explicit Strava connect intent — skip the expert router and reply
    // with the magic link directly. No LLM call needed.
    const status = await getStravaConnectStatus(athleteId);
    replyText = buildConnectReply(status);
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
