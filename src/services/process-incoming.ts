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
import { recordFrame } from "./pending-decisions.js";
import { bindReply } from "./binder.js";
import { detectFlags } from "./flag-detector.js";
import { autoTransitionStaleBlocks } from "../memory/summarize.js";
import type { DecisionFrame } from "../router/types.js";
import { archiveAthlete, isDormant, touchLastSeen } from "./dormancy.js";
import {
  DORMANCY_CHALLENGE_PROMPT,
  DORMANCY_RECHALLENGE_HINT,
  DORMANCY_RESTART_MESSAGE,
  DORMANCY_RESUME_MESSAGE,
  classifyDormancyResponse,
} from "./dormancy-intent.js";

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
        lastSeenAt: athletes.lastSeenAt,
      })
      .from(athletes)
      .where(eq(athletes.id, athleteId))
      .limit(1)
  )[0];
  if (!athleteRow) {
    console.error(`processIncoming: athlete ${athleteId} not found, dropping reply`);
    return;
  }

  // Single lookup of the previous outbound — used by the dormancy and
  // erasure branches to detect "the runner is responding to a prompt
  // we just sent."
  const lastOutbound = (
    await db
      .select({ body: messages.body })
      .from(messages)
      .where(and(eq(messages.athleteId, athleteId), eq(messages.direction, "out")))
      .orderBy(desc(messages.receivedAt))
      .limit(1)
  )[0];
  const lastOutboundBody = lastOutbound?.body ?? null;

  const inDormancyChallenge =
    lastOutboundBody === DORMANCY_CHALLENGE_PROMPT ||
    lastOutboundBody === DORMANCY_RECHALLENGE_HINT;

  // ── Dormancy response (90-day re-auth, phone-churn safety) ──────────
  // Runner is mid-challenge — classify their reply before anything else
  // routes. Erasure intents still pass through if they happen to type
  // "delete my account" instead of YES/NEW; we'll re-prompt as unclear
  // and let them then go through the erasure flow on the next turn.
  if (inDormancyChallenge) {
    const response = classifyDormancyResponse(body);
    let replyText: string;
    if (response === "resume") {
      await touchLastSeen(athleteId);
      replyText = DORMANCY_RESUME_MESSAGE;
    } else if (response === "restart") {
      await archiveAthlete(athleteId);
      replyText = DORMANCY_RESTART_MESSAGE;
      // The row is archived (not deleted) — its FK targets are still
      // valid, so the outbound persist below still works.
    } else {
      replyText = DORMANCY_RECHALLENGE_HINT;
    }
    await sendAndPersist(athleteId, athleteRow.phone, replyText);
    return;
  }

  // ── Deletion intent (GDPR Article 17) ────────────────────────────────
  // Checked BEFORE onboarding/strava/router so a runner can delete their
  // account from any state — including mid-onboarding. Two-phase:
  //   1. Request matches deletion patterns → reply with the confirmation prompt.
  //   2. Confirmation phrase exactly matches AND the previous outbound was
  //      the prompt → execute deletion, send a goodbye message, exit
  //      without persisting the outbound (the athlete row is gone).
  if (
    isDeletionConfirmation(body) &&
    lastOutboundBody === DELETION_CONFIRMATION_PROMPT
  ) {
    const phone = athleteRow.phone;
    await deleteAthlete(athleteId);
    // sendWhatsApp doesn't touch the DB — safe to call after the row's
    // gone. We deliberately don't persist this outbound either.
    sendWhatsApp(phone, DELETION_SUCCESS_MESSAGE).catch((err) =>
      console.error("erasure: goodbye send failed", err),
    );
    return;
  }

  // ── Dormancy detection ──────────────────────────────────────────────
  // Not currently in a challenge — gate on the 90-day gap before any
  // other routing. We deliberately DON'T touchLastSeen yet: the gap has
  // to persist into the next inbound so the response branch above sees
  // "lastOutbound was the prompt."
  if (isDormant(athleteRow.lastSeenAt)) {
    await sendAndPersist(athleteId, athleteRow.phone, DORMANCY_CHALLENGE_PROMPT);
    return;
  }

  // Past dormancy — touch last_seen now so the next inbound sees a
  // fresh timestamp. Done before routing so even a slow LLM call won't
  // drift this.
  await touchLastSeen(athleteId);

  // ── Binder (ET7) + Flag detection (T11) ─────────────────────────────
  // Both writes happen BEFORE the routing branch so the routing call's
  // getMemoryContext sees them. The runner says "my Achilles is sore"
  // → flag is created here → memory context lists it → MARP can
  // acknowledge it in the SAME reply rather than waiting one turn.
  //
  // Run in parallel — they touch different tables and don't observe
  // each other. Errors are swallowed; a failed flag-detect or bind
  // shouldn't block the reply.
  await Promise.all([
    bindReply(athleteId, messageId, body).catch((err) => {
      console.error("binder threw:", err);
    }),
    detectFlags(athleteId, messageId, body).catch((err) => {
      console.error("flag-detector threw:", err);
    }),
    // T8: detect active race blocks past their race_date + grace and
    // transition + summarize them. Cheap when there's nothing to do
    // (single SELECT); the summarizer LLM call only fires for stale
    // blocks and runs fire-and-forget inside.
    autoTransitionStaleBlocks(athleteId).catch((err) => {
      console.error("autoTransitionStaleBlocks threw:", err);
    }),
  ]);

  const history = getAthleticHistory(athleteRow.athleticHistory);

  let replyText: string;
  // ET6: if the expert router emits a decision_frame, we persist it
  // alongside the outbound message so the binder (ET7) has it to resolve
  // against a future runner reply. Only the routing branch produces
  // frames in v1 — onboarding / Strava-connect / dormancy / erasure
  // prompts are single-answer.
  let routerFrame: DecisionFrame | null = null;
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
    routerFrame = result.frame;
  }

  if (!replyText) {
    console.error(`processIncoming: empty reply for message ${messageId}`);
    return;
  }

  const { outboundMessageId } = await sendAndPersist(
    athleteId,
    athleteRow.phone,
    replyText,
  );

  // ET6 + ET8: record the pending decision after we have the outbound
  // id (the back-pointer the binder uses). If Twilio send failed,
  // outboundMessageId is null; we still persist the frame with a null
  // message_id so the binder can match against it (rare path, but
  // skipping the frame entirely would be worse — the runner might
  // re-ask and the structured fork would be lost).
  if (routerFrame) {
    try {
      await recordFrame(athleteId, outboundMessageId, routerFrame);
    } catch (err) {
      console.error("processIncoming: recordFrame failed", err);
    }
  }
}

// Send a reply via Twilio and persist the outbound row. Centralised so
// the dormancy / erasure-prompt branches can use the same pipeline as
// the normal routing branch — they need the outbound persisted too so
// the next inbound's "lastOutbound" check works.
//
// Returns the inserted outbound message_id so the caller can wire it
// into related rows (pending_decisions back-pointer for ET6). When the
// Twilio send fails, outboundMessageId is null and the inbound message
// is already persisted — no rollback needed.
async function sendAndPersist(
  athleteId: string,
  phone: string,
  body: string,
): Promise<{ outboundMessageId: string | null }> {
  let outboundSid: string | undefined;
  try {
    const sendResult = await sendWhatsApp(phone, body);
    outboundSid = sendResult.twilioMessageSid;
  } catch (err) {
    if (err instanceof TwilioSendError) {
      console.error(
        `Twilio send failed (${err.status}): ${err.body.slice(0, 200)}`,
      );
    } else {
      console.error("Twilio send threw:", (err as Error).message);
    }
    return { outboundMessageId: null };
  }

  // Persist the outbound message for the next turn's memory retrieval.
  const [inserted] = await db
    .insert(messages)
    .values({
      athleteId,
      direction: "out",
      body,
      twilioMessageSid: outboundSid,
    })
    .returning({ id: messages.id });
  return { outboundMessageId: inserted?.id ?? null };
}
