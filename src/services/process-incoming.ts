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
import { fireThinkingAck } from "./thinking-ack.js";
import {
  PIVOT_QUESTION,
  PIVOT_REPLY_BYO,
  classifyPivotReply,
  getPivotState,
  isAwaitingPivotChoice,
  withPivotState,
} from "./post-onboarding-pivot.js";
import { generatePlan } from "./plan/generator.js";
import { ingestPlan } from "./plan/ingest.js";
import { saveAthletePlan } from "./plan/storage.js";
import { renderPlanSummary } from "./plan/types.js";
import {
  DECLINED_PREFS,
  REMINDER_AMBIGUOUS_REPLY,
  REMINDER_CAPTURED_REPLY,
  REMINDER_DECLINED_REPLY,
  REMINDER_PROMPT,
  REMINDER_PROMPT_SIGNATURE,
  classifyPrefsReply,
  isPrefsAsked,
} from "./reminders/prefs.js";
import { inferTimezoneFromPhone } from "./reminders/timezone.js";
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
import { ingestFileFromMediaUrl } from "../ingest/file.js";
import {
  CONSENT_AMBIGUOUS_REPLY,
  CONSENT_DECLINED_REPLY,
  PRIVACY_NOTICE,
  buildConsentAcceptedReply,
  classifyConsentReply,
  recordConsentGranted,
} from "./consent.js";
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
  // ET15: when the inbound carried a media attachment (Twilio MediaUrl0),
  // the webhook passes it through. Today only fitness files (GPX) get
  // ingested; everything else falls through to the regular routing
  // branch with the media silently ignored.
  mediaUrl?: string | null,
  mediaContentType?: string | null,
): Promise<void> {
  // Pull phone + athletic_history in one query — we need both regardless
  // of which branch we take.
  const athleteRow = (
    await db
      .select({
        phone: athletes.phone,
        athleticHistory: athletes.athleticHistory,
        lastSeenAt: athletes.lastSeenAt,
        consentGrantedAt: athletes.consentGrantedAt,
        reminderPrefs: athletes.reminderPrefs,
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

  // ── Consent gate (GDPR Article 6) ────────────────────────────────────
  // We cannot legally process a runner's data without explicit informed
  // consent. The very first inbound creates the athlete row (so we can
  // send a reply), but coaching content is gated behind a "YES" reply
  // to the privacy notice. State machine:
  //
  //   consent_granted_at = NULL + last outbound != PRIVACY_NOTICE
  //     → send the notice, return. Subsequent inbound has the notice
  //       as last outbound, so the next branch fires.
  //
  //   consent_granted_at = NULL + last outbound == PRIVACY_NOTICE
  //     → classify the reply.
  //       "yes"-like → set consent_granted_at, fall through to the
  //         normal flow (which will kick off onboarding).
  //       "stop"-like → archive the athlete + send a respectful close.
  //       ambiguous → re-send the notice.
  //
  // Placed AFTER deletion confirmation so a pre-consent runner can
  // still complete a delete-confirm flow (rare but possible if they
  // typed YES DELETE before any privacy notice ever shipped).
  if (!athleteRow.consentGrantedAt) {
    if (lastOutboundBody === PRIVACY_NOTICE) {
      const decision = classifyConsentReply(body);
      if (decision === "decline") {
        const phone = athleteRow.phone;
        await archiveAthlete(athleteId);
        sendWhatsApp(phone, CONSENT_DECLINED_REPLY).catch((err) =>
          console.error("consent: declined-reply send failed", err),
        );
        return;
      }
      if (decision === "ambiguous") {
        await sendAndPersist(athleteId, athleteRow.phone, CONSENT_AMBIGUOUS_REPLY);
        return;
      }
      // accept: persist consent, send the warm-handoff. The next
      // inbound from the runner triggers onboarding.
      // V2: handoff bundles the Strava-first connect offer. Runner
      // can tap the link (then onboarding picks up after) or just
      // reply with their name/goal to skip Strava.
      await recordConsentGranted(athleteId);
      const acceptedReply = await buildConsentAcceptedReply(athleteId);
      await sendAndPersist(athleteId, athleteRow.phone, acceptedReply);
      return;
    }
    // First-touch case: no prior notice. Ship it and exit.
    await sendAndPersist(athleteId, athleteRow.phone, PRIVACY_NOTICE);
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

  // ── File ingest (ET15) ───────────────────────────────────────────────
  // If the runner attached a fitness file (GPX today; FIT/TCX get a
  // friendly reject), short-circuit the LLM router. The file becomes
  // an activity row and the reply is a confirmation summarising what
  // we extracted. Subsequent training questions can reference it via
  // memory context on the next turn.
  if (mediaUrl) {
    const reply = await handleFileUpload(
      athleteId,
      mediaUrl,
      mediaContentType ?? undefined,
    );
    if (reply !== null) {
      await sendAndPersist(athleteId, athleteRow.phone, reply);
      return;
    }
    // null reply = not a recognised fitness file. Fall through to the
    // normal routing branches so an attached image / voice note doesn't
    // get treated as a silent failure.
  }

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
    // V1: fire "thinking…" immediately — onboarding LLM round-trip is
    // typically 2-4s, long enough for silence to feel ambiguous.
    fireThinkingAck(athleteRow.phone);
    const onboardingResult = await runOnboardingTurn(
      athleteId,
      messageId,
      body,
    );
    replyText = onboardingResult.reply;

    // When onboarding wraps up this turn:
    //  1. Strava offer (if not connected) — second-chance prompt
    //  2. V5: append the post-onboarding plan pivot — runners need a
    //     concrete next step, not "ask me anything"
    //  3. V5: persist pivot_state = "awaiting_choice" so the next
    //     inbound is matched against the a/b classifier
    if (onboardingResult.finishedThisTurn) {
      const offer = await buildOnboardingStravaOffer(athleteId).catch(() => null);
      if (offer) replyText += offer;
      replyText += PIVOT_QUESTION;
      const updatedHistory = withPivotState(
        onboardingResult.newHistory,
        "awaiting_choice",
      );
      await db
        .update(athletes)
        .set({ athleticHistory: updatedHistory })
        .where(eq(athletes.id, athleteId));
    }
  } else if (
    !isPrefsAsked(athleteRow.reminderPrefs) &&
    lastOutboundBody !== null &&
    lastOutboundBody.includes(REMINDER_PROMPT_SIGNATURE)
  ) {
    // V8: runner is responding to the reminder pref prompt.
    // We're past the pivot (plan is saved); just classify and persist.
    const result = classifyPrefsReply(body);
    if (result.kind === "decline") {
      await db
        .update(athletes)
        .set({ reminderPrefs: DECLINED_PREFS })
        .where(eq(athletes.id, athleteId));
      replyText = REMINDER_DECLINED_REPLY;
    } else if (result.kind === "time_specified") {
      await db
        .update(athletes)
        .set({
          reminderPrefs: { enabled: true, time_local: result.time_local },
        })
        .where(eq(athletes.id, athleteId));
      replyText = REMINDER_CAPTURED_REPLY(result.time_local);
    } else {
      replyText = REMINDER_AMBIGUOUS_REPLY;
    }
  } else if (getPivotState(history) === "awaiting_plan") {
    // V6: runner is in the BYO branch — anything they send next is
    // treated as the pasted plan. Parse via LLM ingest, save, and
    // confirm. On parse failure, send a friendly clarification so
    // the runner can retry.
    fireThinkingAck(athleteRow.phone);
    const result = await ingestPlan({ athleteId, messageId, pastedText: body });
    if (result.ok) {
      await saveAthletePlan(athleteId, result.plan);
      const updatedHistory = withPivotState(history, "done");
      const tz = inferTimezoneFromPhone(athleteRow.phone);
      await db
        .update(athletes)
        .set({
          athleticHistory: updatedHistory,
          ...(tz ? { timezone: tz } : {}),
        })
        .where(eq(athletes.id, athleteId));
      replyText = renderPlanSummary(result.plan) + REMINDER_PROMPT;
    } else if (result.reason === "not_a_plan") {
      replyText =
        "That didn't look like a training plan to me — looked more like a " +
        "general message. Paste the plan itself (week-by-week or a summary), " +
        "or reply 'build it' if you'd rather I build one from scratch.";
    } else {
      replyText =
        "I downloaded the plan but couldn't quite parse it. Try splitting it " +
        "into clear week sections (Week 1, Week 2…) and resend? Or reply " +
        "'build it' and I'll build one from scratch.";
    }
  } else if (isAwaitingPivotChoice(lastOutboundBody, history)) {
    // V5: runner is responding to the post-onboarding pivot.
    // Classify a/b; on "other", fall through to the expert router so
    // a free-form question never traps the runner inside the pivot.
    const choice = classifyPivotReply(body);
    if (choice === "byo") {
      replyText = PIVOT_REPLY_BYO;
      const updatedHistory = withPivotState(history, "awaiting_plan");
      await db
        .update(athletes)
        .set({ athleticHistory: updatedHistory })
        .where(eq(athletes.id, athleteId));
    } else if (choice === "build") {
      // V6: runner picked (b) — generate the plan in this same turn
      // rather than asking them to send another "go" message.
      fireThinkingAck(athleteRow.phone);
      try {
        const plan = await generatePlan({ athleteId, messageId });
        await saveAthletePlan(athleteId, plan);
        const updatedHistory = withPivotState(history, "done");
        const tz = inferTimezoneFromPhone(athleteRow.phone);
        await db
          .update(athletes)
          .set({
            athleticHistory: updatedHistory,
            ...(tz ? { timezone: tz } : {}),
          })
          .where(eq(athletes.id, athleteId));
        replyText = renderPlanSummary(plan) + REMINDER_PROMPT;
      } catch (err) {
        console.error("plan-generator failed:", (err as Error).message);
        replyText =
          "Couldn't build the plan this turn — something went sideways on " +
          "my side. Try again in a moment, or paste a plan you already have " +
          "and I'll work from that.";
      }
    } else {
      // Ambiguous reply — route to the expert. Don't auto-clear the
      // pivot_state; the runner can still answer a/b on the next turn
      // if they want to.
      fireThinkingAck(athleteRow.phone);
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
  } else if (looksLikeStravaConnect(body)) {
    // Explicit Strava connect intent — skip the expert router and reply
    // with the magic link directly. No LLM call needed.
    const status = await getStravaConnectStatus(athleteId);
    replyText = buildConnectReply(status);
  } else {
    // Normal expert routing branch.
    // V1: fire "thinking…" immediately — multi-domain routing can take
    // 10-25s, so the runner needs a signal that MARP received the message.
    fireThinkingAck(athleteRow.phone);
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
// Try to ingest a fitness file from the runner's MediaUrl0. Returns:
//   - A confirmation reply string when the ingest succeeded
//   - A friendly explanation when the format is recognised-but-rejected
//     (FIT / TCX) or the parse failed
//   - null when the media wasn't a recognised fitness file at all
//     (image, voice note, etc.) — caller falls through to normal routing
async function handleFileUpload(
  athleteId: string,
  mediaUrl: string,
  contentType: string | undefined,
): Promise<string | null> {
  const result = await ingestFileFromMediaUrl(athleteId, mediaUrl, contentType);
  if (result.ok) {
    const km = (result.distanceM / 1000).toFixed(2);
    const dur = formatDurationHuman(result.durationS);
    const tail = result.inserted
      ? ""
      : " (already in your log — no double-counting)";
    const namePart = result.name ? ` "${result.name}"` : "";
    return `Got it. Logged a ${km}km ${result.discipline}${namePart} (${dur}).${tail}`;
  }
  switch (result.reason) {
    case "unsupported_format": {
      if (result.detail === "fit" || result.detail === "tcx") {
        return (
          `I can read GPX files for now — ${result.detail!.toUpperCase()} parsing is coming, ` +
          "but for now try exporting as GPX from your watch app and re-send."
        );
      }
      // Unknown / not a fitness file — let the normal routing branch
      // handle it. The runner may have sent an image or voice note.
      return null;
    }
    case "download_failed":
      return "Couldn't download that file. Try sending it again?";
    case "download_too_large":
      return "That file is too big for me (5 MB cap). Trim it or send a summary instead?";
    case "parse_failed":
      return (
        "I downloaded the file but couldn't make sense of it. Make sure it's a " +
        "valid GPX export — some apps wrap multiple sessions in one file, which " +
        "I don't handle yet."
      );
    case "missing_credentials":
      // Operator-side problem, not the runner's. Stay quiet rather than
      // exposing the configuration gap; the file just won't ingest.
      return null;
  }
}

function formatDurationHuman(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}`;
  return `${m}min`;
}

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
