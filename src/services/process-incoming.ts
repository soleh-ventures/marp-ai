import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { athletes, messages } from "../db/schema.js";
import {
  getAthleticHistory,
  isOnboarded,
  runOnboardingTurn,
  type AthleticHistory,
} from "../flows/onboarding.js";
import { getMemoryContext } from "../memory/retrieve.js";
import { route } from "../router/index.js";
import { classify } from "../router/classifier.js";
import { triageSafety } from "./safety/triage.js";
import { alertOperator } from "./safety/alert.js";
import { recordSafetyEvent } from "./safety/events.js";
import { emergencyResponse, referralPrefixFor } from "./safety/responses.js";
import { sendWhatsApp, TwilioSendError } from "./twilio-send.js";
import { deliver } from "./messaging/deliver.js";
import { fireTypingIndicator } from "./typing-indicator.js";
import {
  PIVOT_QUESTION,
  PIVOT_REPLY_BYO,
  Q_PIVOT,
  classifyPivotReply,
  getPivotState,
  isAwaitingPivotChoice,
  withPivotState,
} from "./post-onboarding-pivot.js";
import {
  MSG_CALIB_OFFER,
  MSG_COACH_QUESTION,
  Q_CALIB,
  Q_COACH,
  buildReask,
  getCoachPrefs,
  getPrefsState,
  handlePrefsTurn,
  startPrefsFlow,
} from "../flows/preferences.js";
import type { ChoiceQuestion } from "./messaging/choices.js";
import { matchFreeText } from "./messaging/choices.js";
import {
  getPendingChoice,
  resolvePendingChoice,
  setPendingChoice,
} from "./messaging/pending-choice.js";
import { logFunnel } from "./funnel.js";
import {
  CAL_LATER_REPLY,
  CAL_NOT_CONFIGURED_REPLY,
  CAL_OFFER,
  CAL_OFFER_SIGNATURE,
  Q_CAL_OFFER,
  buildCalendarExportReply,
  looksLikeCalendarExportRequest,
  looksLikeCalendarResetRequest,
  resetCalendarFeed,
} from "./intents/calendar-export.js";
import { applyPrefEdit, detectPrefEdit } from "./intents/pref-edit.js";
import {
  looksLikeGarminConnect,
  recordGarminInterest,
} from "./intents/integrations.js";
import { classifyPivotIntent, fastPathChoice } from "./pivot-intent.js";
import { generatePlan } from "./plan/generator.js";
import { ingestPlan } from "./plan/ingest.js";
import { adjustPlan } from "./plan/adjust.js";
import { saveAthletePlan, getStoredPlan } from "./plan/storage.js";
import { renderPlanSummary, renderOpenQuestions } from "./plan/types.js";
import {
  DECLINED_PREFS,
  REMINDER_AMBIGUOUS_REPLY,
  REMINDER_CAPTURED_REPLY,
  REMINDER_DECLINED_REPLY,
  REMINDER_PROMPT,
  REMINDER_PROMPT_SIGNATURE,
  REMINDER_REASK,
  Q_REMINDER,
  type PrefsCaptureResult,
  classifyPrefsReply,
  isPrefsAsked,
  looksLikeReminderAffirmation,
  looksLikeReminderRequest,
} from "./reminders/prefs.js";
import { bestTimezoneForAthlete } from "./strava-activities.js";
import {
  applyLocationChange,
  extractLocationFromMessage,
  type LocationChange,
  looksLikeTimezoneChange,
} from "./timezone-override.js";
import {
  profileQuestionKind,
  buildProfileReadback,
  type ProfileQuestionKind,
} from "./profile-readback.js";
import {
  looksLikeWeekReviewRequest,
  buildWeeklyEvaluation,
  looksLikeRevertRequest,
  revertLastWeeklyAdjustment,
  type WeeklyEvaluation,
} from "./weekly-evaluation.js";
import {
  buildConnectReply,
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
import { extractRunFeeling } from "./run-feeling.js";
import { applyProposalResolution } from "./run-retro.js";
import type { BindResult } from "./binder.js";
import { autoTransitionStaleBlocks } from "../memory/summarize.js";
import { ingestFileFromMediaUrl, isFitnessFile } from "../ingest/file.js";
import { extractDocuments, type MediaItem } from "../ingest/document.js";
import {
  CONSENT_AMBIGUOUS_REPLY,
  CONSENT_DECLINED_REPLY,
  PRIVACY_NOTICE,
  Q_CONSENT,
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

// Ingest a BYO plan (pasted text OR the contents of an uploaded text file),
// persist it, advance pivot_state → done, and return the runner-facing reply
// (plan summary on success, a recoverable clarification on failure). Shared by
// the text-paste path, the choice-step paste, and the long-plan-as-file path
// so all three behave identically.
async function ingestAndSaveByoPlan(input: {
  athleteId: string;
  messageId: string;
  phone: string;
  history: AthleticHistory;
  pastedText: string;
}): Promise<string> {
  const result = await ingestPlan({
    athleteId: input.athleteId,
    messageId: input.messageId,
    pastedText: input.pastedText,
  });
  if (result.ok) {
    await saveAthletePlan(input.athleteId, result.plan);
    logFunnel("plan_created", input.athleteId);
    const updatedHistory = withPivotState(input.history, "done");
    // F8c: Strava-derived tz (where they run) beats the phone dial code.
    const tz = await bestTimezoneForAthlete(input.athleteId, input.phone);
    await db
      .update(athletes)
      .set({
        athleticHistory: updatedHistory,
        ...(tz ? { timezone: tz } : {}),
      })
      .where(eq(athletes.id, input.athleteId));
    return renderPlanSummary(result.plan) + CAL_OFFER;
  }
  if (result.reason === "not_a_plan") {
    return (
      "That didn't look like a training plan to me — looked more like a " +
      "general message. Paste the plan itself (week-by-week or a summary), " +
      "or just say 'build it' and I'll create one from scratch."
    );
  }
  return (
    "I downloaded the plan but couldn't quite parse it. Try splitting it " +
    "into clear week sections (Week 1, Week 2…) and resend? Or say " +
    "'build it' and I'll build one from scratch."
  );
}

// Copy for a runner who clearly TRIED to send a plan but it never arrived —
// the WhatsApp/Twilio 1600-char cap silently drops a long paste before it
// reaches us, so we can't see it to say anything smarter. Explain + offer the
// two ways through (text file, or split it). Also reused on a doc that failed
// to download.
const PLAN_NOT_RECEIVED_REPLY =
  "I didn't get any plan text — heads up, WhatsApp drops messages longer than " +
  "~1600 characters before they reach me, so a long paste won't come through. " +
  "Two ways to get it to me:\n" +
  "• Send it as a file (tap 📎) — a photo/screenshot, PDF, Word, Excel, or " +
  ".txt all work, any length\n" +
  "• Or split it into 2-3 shorter messages\n\n" +
  "Or just say 'build it' and I'll make one from scratch.";

// Conservative detection of "I (already) sent/pasted the plan" — a short
// message claiming a paste landed. Used only while we're waiting for the plan,
// to recover the dead-end where a too-long paste vanished. Kept tight (short
// messages, explicit verbs) to avoid stealing real questions from the expert.
function looksLikePasteClaim(body: string): boolean {
  const t = body.trim();
  if (t.length === 0 || t.length > 90) return false;
  if (/\b(pasted|sent|shared|posted|attached|typed|copied)\b/i.test(t)) return true;
  // "did you get it?", "do you see the plan?", "got it?"
  return /\b(get|got|see|receive[d]?|got)\b.{0,18}\b(it|that|the\s+plan|my\s+plan|message)\b/i.test(
    t,
  );
}

// Friendly copy for an uploaded plan that arrived but couldn't be read.
function planDocErrorReply(
  reason: "no_supported_files" | "all_failed" | "missing_credentials",
): string {
  if (reason === "no_supported_files") {
    return (
      "I got your file, but it's not a format I can read as a plan. Send it as " +
      "a photo/screenshot, a PDF, a Word (.docx) or Excel (.xlsx) file, or a " +
      ".txt — or just say 'build it' and I'll create one from scratch."
    );
  }
  if (reason === "missing_credentials") {
    return "I couldn't fetch that file just now — try sending it again in a moment, or paste the plan in chat.";
  }
  // all_failed
  return (
    "I couldn't read that file. If it's a photo, make sure the text is in focus " +
    "and try again; otherwise send it as a PDF or .txt, or paste the key weeks " +
    "in chat. Or say 'build it' and I'll make one."
  );
}

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
  // The Twilio SID of this inbound message (SM…). Used to show the native
  // WhatsApp "typing…" indicator while we work. Optional so non-Twilio-driven
  // callers (tests, synthetic turns) skip the indicator instead of breaking.
  inboundSid?: string | null,
  // ALL attachments on this message (Twilio MediaUrl0..N). The plan-document
  // path reads every one (a long plan split across photos, a .docx, etc.);
  // the legacy fitness-file path uses mediaUrl (the first). Defaults to the
  // single (mediaUrl, mediaContentType) pair when not supplied.
  media?: MediaItem[],
  // synthetic: the body is a canonical value from a button tap — a string WE
  // wrote, not the athlete's prose. Skips safety triage and the free-text
  // enrichment LLMs (binder, flag detector, run feeling): a tap can't be a
  // crisis message, and canonical words like "hard"/"aggressive" must never
  // become spurious sentiment flags (eng amendment 3). Branch logic is
  // unchanged — one pipeline for taps and typing.
  opts?: { synthetic?: boolean },
): Promise<void> {
  const synthetic = opts?.synthetic === true;
  // The full attachment list — prefer the explicit array; fall back to the
  // single legacy pair so existing callers keep working.
  const allMedia: MediaItem[] =
    media && media.length > 0
      ? media
      : mediaUrl
        ? [{ url: mediaUrl, contentType: mediaContentType ?? undefined }]
        : [];
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
        country: athletes.country,
      })
      .from(athletes)
      .where(eq(athletes.id, athleteId))
      .limit(1)
  )[0];
  if (!athleteRow) {
    console.error(`processIncoming: athlete ${athleteId} not found, dropping reply`);
    return;
  }

  // S1 (KER-29): safety triage runs FIRST, on every inbound, before any
  // onboarding/coaching/command logic. A Tier-0 emergency short-circuits
  // to a scripted, region-aware response + operator alert — never an LLM
  // coaching reply. A Tier-1 red flag lets the normal flow run but
  // prepends a hard referral to whatever reply gets built.
  const triage = synthetic
    ? ({ tier: "none", category: "none", reason: "" } as Awaited<
        ReturnType<typeof triageSafety>
      >)
    : await triageSafety(body, { athleteId, messageId });
  if (triage.tier === "emergency") {
    // The runner is in crisis — get the help number to them FIRST. The
    // audit write + operator alert must NEVER delay the crisis reply, so
    // they run after the send (and the alert is fire-and-forget, since a
    // slow/hanging operator WhatsApp send must not block anything).
    await sendAndPersist(
      athleteId,
      athleteRow.phone,
      emergencyResponse(athleteRow.country),
    );
    await recordSafetyEvent(athleteId, messageId, triage, body);
    void alertOperator(athleteId, triage, body).catch(() => {});
    return;
  }
  if (triage.tier === "referral") {
    // S4: durable audit + operator alert. Not a crisis path, so a blocking
    // await is fine — the referral is prepended to the normal reply below.
    await recordSafetyEvent(athleteId, messageId, triage, body);
    await alertOperator(athleteId, triage, body);
  }
  const safetyReferral = referralPrefixFor(triage);

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
    // The notice may have shipped with the numbered-text fallback appended
    // (rendered body is what's persisted — eng amendment 4), so match on
    // prefix, not equality.
    if (lastOutboundBody !== null && lastOutboundBody.startsWith(PRIVACY_NOTICE)) {
      const decision = classifyConsentReply(body);
      if (decision === "decline") {
        await archiveAthlete(athleteId);
        deliver(athleteId, CONSENT_DECLINED_REPLY).catch((err) =>
          console.error("consent: declined-reply send failed", err),
        );
        return;
      }
      if (decision === "ambiguous") {
        await sendAndPersist(
          athleteId,
          athleteRow.phone,
          CONSENT_AMBIGUOUS_REPLY,
          Q_CONSENT,
        );
        return;
      }
      // Accept: persist consent and run intake turn 1 RIGHT NOW — the tap
      // flows straight into the first question instead of a dead handoff
      // message (Strava offer removed: API paywalled, offer died with it).
      await recordConsentGranted(athleteId);
      logFunnel("onboarding_started", athleteId);
      try {
        const first = await runOnboardingTurn(athleteId, messageId, body);
        await sendAndPersist(athleteId, athleteRow.phone, first.reply);
      } catch (err) {
        console.error("consent: intake turn 1 failed", err);
        await sendAndPersist(
          athleteId,
          athleteRow.phone,
          "You're in. Tell me about yourself — name, age, your goal (race + " +
            "date, or just \"get fitter\"), how much you run now, days per " +
            "week you can train, any injuries, and which city you're in.",
        );
      }
      return;
    }
    // First-touch case: no prior notice. Ship it (with consent buttons) and exit.
    await sendAndPersist(athleteId, athleteRow.phone, PRIVACY_NOTICE, Q_CONSENT);
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

  // ── Fitness file ingest (ET15) ───────────────────────────────────────
  // A GPX (FIT/TCX get a friendly reject) becomes an activity row — short
  // circuit the router. ONLY fitness files run here; plan documents (photos,
  // PDFs, Word/Excel, .txt) are handled by the plan-upload path below, which
  // needs the runner's pivot state.
  if (allMedia[0] && isFitnessFile(allMedia[0].url, allMedia[0].contentType)) {
    const reply = await handleFileUpload(
      athleteId,
      allMedia[0].url,
      allMedia[0].contentType ?? undefined,
    );
    if (reply !== null) {
      await sendAndPersist(athleteId, athleteRow.phone, reply);
      return;
    }
    // null reply = couldn't read it. Fall through to normal routing.
  }

  const history = getAthleticHistory(athleteRow.athleticHistory);

  // ── Uploaded BYO plan (any format, one or many files) ────────────────
  // A pasted plan hits Twilio's 1600-char inbound cap and silently vanishes
  // (dogfood bug). A file attachment has no such limit. If the runner is in a
  // plan-accepting state and sent plan documents (photo / screenshot / PDF /
  // Word / Excel / .txt — anything that isn't a fitness file), read them ALL
  // and route the combined text to the plan parser. Returns early (like the
  // fitness path) so file uploads skip the binder/flag work below.
  const planDocs = allMedia.filter((m) => !isFitnessFile(m.url, m.contentType));
  if (planDocs.length > 0) {
    const pivotState = getPivotState(history);
    const inPlanPaste =
      pivotState === "awaiting_plan" ||
      (!getStoredPlan(history) && isAwaitingPivotChoice(lastOutboundBody, history));
    if (inPlanPaste) {
      fireTypingIndicator(inboundSid);
      // Read every attachment (photo / screenshot / PDF / .docx / .xlsx /
      // .txt, one or several) into one text corpus, then parse as the plan.
      const extracted = await extractDocuments(planDocs, { athleteId, messageId });
      const reply = extracted.ok
        ? await ingestAndSaveByoPlan({
            athleteId,
            messageId,
            phone: athleteRow.phone,
            history,
            pastedText: extracted.text,
          })
        : planDocErrorReply(extracted.reason);
      await sendAndPersist(athleteId, athleteRow.phone, reply);
      return;
    }
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
  const [bindRes] = synthetic
    ? [{ resolved: false } as BindResult]
    : await Promise.all([
    bindReply(athleteId, messageId, body).catch((err): BindResult => {
      console.error("binder threw:", err);
      return { resolved: false };
    }),
    detectFlags(athleteId, messageId, body).catch((err) => {
      console.error("flag-detector threw:", err);
    }),
    // M1 (T4): capture how the runner's recent run FELT into a structured
    // RunFeeling. Cost-guarded — only calls the LLM when there's a run in the
    // last 48h for the feeling to attach to, so this is a cheap no-op the rest
    // of the time. Pain is recorded in the feeling; the injury active_flag is
    // left to the flag-detector above (no duplicate flags).
    extractRunFeeling({ athleteId, messageId, body }).catch((err) => {
      console.error("run-feeling threw:", err);
    }),
    // T8: detect active race blocks past their race_date + grace and
    // transition + summarize them. Cheap when there's nothing to do
    // (single SELECT); the summarizer LLM call only fires for stale
    // blocks and runs fire-and-forget inside.
    autoTransitionStaleBlocks(athleteId).catch((err) => {
      console.error("autoTransitionStaleBlocks threw:", err);
    }),
  ]);

  // M1 (T6): if the binder just resolved a frame that belongs to a retro
  // proposal, apply (accept) or decline the plan change. No-op for ordinary
  // conversational forks. Runs after the batch so the resolution is committed.
  if (bindRes.resolved) {
    await applyProposalResolution({
      athleteId,
      messageId,
      frameId: bindRes.frameId,
      key: bindRes.key,
    }).catch((err) => {
      console.error("proposal apply threw:", err);
    });
  }

  let replyText: string;
  // Closed question attached to this turn's reply (inline keyboard on
  // Telegram; numbered-text fallback elsewhere). Set by branches that ask.
  let replyChoices: ChoiceQuestion | undefined;
  // ET6: if the expert router emits a decision_frame, we persist it
  // alongside the outbound message so the binder (ET7) has it to resolve
  // against a future runner reply. Only the routing branch produces
  // frames in v1 — onboarding / Strava-connect / dormancy / erasure
  // prompts are single-answer.
  let routerFrame: DecisionFrame | null = null;
  // F8d: holds the IANA tz extracted from a location-change message, when
  // the timezone-override branch fires (assigned in its else-if condition).
  let locChange: LocationChange | null = null;
  // RC3: holds the parsed reminder request when that branch fires.
  let reminderReq: PrefsCaptureResult = { kind: "ambiguous" };
  // KER-78 (1d): holds the profile-question kind + the deterministic
  // readback when that branch fires (assigned in its else-if condition).
  let profileKind: ProfileQuestionKind | null = null;
  let profileReadback: string | null = null;
  // KER-79 (Phase 2): holds the coach evaluation when the runner asks how
  // their week went (reactive, read-only path).
  let weeklyEval: WeeklyEvaluation | null = null;
  // KER-79 (Phase 2): holds the confirmation when the runner reverts a
  // coach-applied weekly adjustment ("keep it as it was").
  let revertReply: string | null = null;
  // Adaptive pivot (build path): generate the plan in this turn, persist it +
  // the best timezone, mark the pivot done, and return the runner-facing reply.
  // Shared by the (b) choice branch and the "changed my mind, build it" escape
  // out of awaiting_plan so the two can't drift. On generator failure returns a
  // recoverable message rather than throwing.
  const buildPlanForRunner = async (): Promise<string> => {
    try {
      const plan = await generatePlan({ athleteId, messageId });
      await saveAthletePlan(athleteId, plan);
      logFunnel("plan_created", athleteId);
      const updatedHistory = withPivotState(history, "done");
      // F8c: Strava-derived tz (where they run) beats the phone dial code.
      const tz = await bestTimezoneForAthlete(athleteId, athleteRow.phone);
      await db
        .update(athletes)
        .set({
          athleticHistory: updatedHistory,
          ...(tz ? { timezone: tz } : {}),
        })
        .where(eq(athletes.id, athleteId));
      // v1.3 (A3): draft-first hooks — invite collaboration on the fresh plan
      // before the reminder ask. Empty string when the model had no open
      // questions, so the message stays clean.
      return renderPlanSummary(plan) + renderOpenQuestions(plan) + CAL_OFFER;
    } catch (err) {
      console.error("plan-generator failed:", (err as Error).message);
      return (
        "Couldn't build the plan this turn — something went sideways on " +
        "my side. Try again in a moment, or paste a plan you already have " +
        "and I'll work from that."
      );
    }
  };
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
    fireTypingIndicator(inboundSid);
    const onboardingResult = await runOnboardingTurn(
      athleteId,
      messageId,
      body,
    );
    replyText = onboardingResult.reply;

    // When the LLM intake wraps up this turn, the deterministic preference
    // phase begins: mirror card first (the athlete sees they were heard),
    // then the three taps, holistic, and only then the plan pivot. The old
    // Strava offer died with the paid API.
    if (onboardingResult.finishedThisTurn) {
      const started = await startPrefsFlow(athleteId, onboardingResult.newHistory);
      replyText += `\n\n${started.reply}`;
      replyChoices = started.choices;
    }
  } else if (
    getPrefsState(history) !== undefined &&
    getPrefsState(history) !== "done"
  ) {
    // ── Preference phase (deterministic, no LLM per tap) ────────────────
    // Re-entry recap: they went silent mid-flow and came back — one line of
    // orientation before the flow resumes (design finding 5).
    const REENTRY_GAP_MS = 12 * 60 * 60 * 1000;
    const cameBack =
      athleteRow.lastSeenAt !== null &&
      Date.now() - athleteRow.lastSeenAt.getTime() > REENTRY_GAP_MS;
    const recap = cameBack
      ? "Welcome back — your profile's saved, we're a couple of taps from your plan.\n\n"
      : "";
    const turn = await handlePrefsTurn({ athleteId, messageId, body, history });
    if (turn.kind === "handled") {
      replyText = recap + turn.reply;
      replyChoices = turn.choices;
      if (turn.pivotReady) {
        // Prefs + holistic done → the plan pivot, with buttons. Re-read
        // history (handlePrefsTurn just wrote it) before setting pivot state.
        const [freshRow] = await db
          .select({ athleticHistory: athletes.athleticHistory })
          .from(athletes)
          .where(eq(athletes.id, athleteId))
          .limit(1);
        const fresh = getAthleticHistory(freshRow?.athleticHistory);
        await db
          .update(athletes)
          .set({ athleticHistory: withPivotState(fresh, "awaiting_choice") })
          .where(eq(athletes.id, athleteId));
        replyText = replyText
          ? `${replyText}${PIVOT_QUESTION}`
          : PIVOT_QUESTION.trimStart();
        replyChoices = Q_PIVOT;
      }
    } else {
      // Interruption: answer the actual question in persona, then re-ask the
      // open preference question once; a second miss applies a SPOKEN default.
      fireTypingIndicator(inboundSid);
      const memory = await getMemoryContext(athleteId);
      const routed = await route({
        message: body,
        athleteId,
        messageId,
        contextSummary: memory.text,
      });
      const reask = await buildReask(athleteId, history);
      replyText = routed.finalText.trim() + reask.append;
      replyChoices = reask.choices;
      routerFrame = routed.frame;
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
          reminderPrefs: {
            enabled: true,
            time_local: result.time_local,
            timing: result.timing,
          },
        })
        .where(eq(athletes.id, athleteId));
      replyText = REMINDER_CAPTURED_REPLY(result.time_local, result.timing);
    } else if (looksLikeReminderAffirmation(body)) {
      // KER-73: a yes-without-a-time ("sure", "yes please") — nudge for the
      // actual time rather than routing an empty question to the expert.
      replyText = REMINDER_AMBIGUOUS_REPLY;
    } else {
      // KER-73: the runner asked something else while the reminder ask was
      // still open. Answer THAT via the expert router and re-append the
      // reminder ask so it stays settable later — don't trap them in the
      // prompt (mirrors the pivot branch's free-form fallback).
      fireTypingIndicator(inboundSid);
      const memory = await getMemoryContext(athleteId);
      const routed = await route({
        message: body,
        athleteId,
        messageId,
        contextSummary: memory.text,
      });
      replyText = routed.finalText.trim() + REMINDER_REASK;
      routerFrame = routed.frame;
    }
  } else if (getPivotState(history) === "awaiting_plan") {
    // Adaptive pivot: the runner chose BYO and we're waiting for the paste.
    // Read intent first so they're NEVER trapped. The old code treated every
    // message as a plan paste, so a runner who said "build it" got the
    // "that's not a plan, reply 'build it'" clarification forever — an
    // inescapable loop, with no code path actually handling "build it" here.
    fireTypingIndicator(inboundSid);
    const fast = fastPathChoice(body);
    const intent =
      fast === "build"
        ? "build"
        : fast === "byo"
          ? "plan_content"
          : (
              await classifyPivotIntent({
                athleteId,
                messageId,
                body,
                phase: "awaiting_plan",
              })
            ).intent;

    if (intent === "build") {
      // Changed their mind — build it now (same path as the (b) choice).
      replyText = await buildPlanForRunner();
    } else if (intent === "question") {
      if (looksLikePasteClaim(body)) {
        // They think they sent the plan but we have nothing — almost always a
        // >1600-char paste that Twilio dropped before it reached us. Explain
        // the limit + the two ways through instead of a blank "I don't see it."
        replyText = PLAN_NOT_RECEIVED_REPLY;
      } else {
        // A genuine question while we wait for the paste. Answer it via the
        // expert and keep awaiting_plan so they can still paste next turn —
        // don't trap them, don't lose the BYO intent.
        const memory = await getMemoryContext(athleteId);
        const routed = await route({
          message: body,
          athleteId,
          messageId,
          contextSummary: memory.text,
        });
        replyText = routed.finalText.trim();
        routerFrame = routed.frame;
      }
    } else {
      // plan_content / byo → treat as the pasted plan (ingest, save, confirm;
      // recoverable clarification on parse failure).
      replyText = await ingestAndSaveByoPlan({
        athleteId,
        messageId,
        phone: athleteRow.phone,
        history,
        pastedText: body,
      });
    }
  } else if (
    isAwaitingPivotChoice(lastOutboundBody, history) ||
    // RC1 (v1.3): resilience fallback. An onboarded runner with NO stored
    // plan who clearly expresses build/BYO intent ("build training plan",
    // "make me a plan", "I have a plan") gets handled even if the formal
    // awaiting_choice state was lost (e.g. they asked questions first, so
    // the pivot prompt is no longer the last outbound). Without this, clear
    // build intent rotted in the expert router, which improvised a plan in
    // prose and never called generatePlan. "other" still routes onward.
    (!getStoredPlan(history) && classifyPivotReply(body) !== "other")
  ) {
    // Adaptive pivot: read what the runner MEANS, not which keyword they hit.
    // A bare "a"/"b" tap short-circuits (no model call); everything else gets
    // an LLM intent read so natural phrasing like "(b) but my first day should
    // be June 3rd" is honoured as (b) instead of mis-firing on the word
    // "first". On "question" we route to the expert so a free-form reply never
    // traps the runner inside the pivot.
    const fast = fastPathChoice(body);
    // A bare "a" tap replies instantly (no model call). Everything else does
    // slow work (LLM intent read, plan build, or ingest), so warn we're on it.
    if (fast !== "byo") fireTypingIndicator(inboundSid);
    const read = fast
      ? { intent: fast, reply: null as string | null }
      : await classifyPivotIntent({
          athleteId,
          messageId,
          body,
          phase: "choice",
        });

    if (read.intent === "byo") {
      logFunnel("pivot_chosen", athleteId);
      // Coach-voice acknowledgement (LLM-generated, adapted to what they
      // said); fall back to the static line only if the model gave none.
      replyText = read.reply ?? PIVOT_REPLY_BYO;
      const updatedHistory = withPivotState(history, "awaiting_plan");
      await db
        .update(athletes)
        .set({ athleticHistory: updatedHistory })
        .where(eq(athletes.id, athleteId));
    } else if (read.intent === "build") {
      logFunnel("pivot_chosen", athleteId);
      // Runner picked (b) — generate the plan in this same turn.
      replyText = await buildPlanForRunner();
    } else if (read.intent === "plan_content") {
      // They pasted an actual plan instead of choosing — ingest it directly.
      const result = await ingestPlan({ athleteId, messageId, pastedText: body });
      if (result.ok) {
        await saveAthletePlan(athleteId, result.plan);
        const updatedHistory = withPivotState(history, "done");
        const tz = await bestTimezoneForAthlete(athleteId, athleteRow.phone);
        await db
          .update(athletes)
          .set({
            athleticHistory: updatedHistory,
            ...(tz ? { timezone: tz } : {}),
          })
          .where(eq(athletes.id, athleteId));
        replyText = renderPlanSummary(result.plan) + CAL_OFFER;
      } else {
        // Looked like a paste but didn't parse — move into awaiting_plan so the
        // next message is handled as the (clarified) paste rather than re-asked.
        const updatedHistory = withPivotState(history, "awaiting_plan");
        await db
          .update(athletes)
          .set({ athleticHistory: updatedHistory })
          .where(eq(athletes.id, athleteId));
        replyText =
          "I couldn't quite parse that as a plan. Paste it week-by-week (Week 1, " +
          "Week 2…) or as a summary, or just say 'build it' and I'll create one.";
      }
    } else {
      // Question / small talk — route to the expert. Don't clear pivot_state;
      // the runner can still answer a/b on the next turn.
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
  } else if (
    (profileKind = profileQuestionKind(body)) !== null &&
    (profileReadback = await buildProfileReadback(athleteId, profileKind)) !== null
  ) {
    // KER-78 (1d): direct factual question about their own profile ("where
    // do I live?", "what's my goal?"). Answer from stored data with NO LLM
    // — the whole bug class is the model confabulating these. The cheap
    // regex pre-check runs first; the DB read only happens on a match, and
    // falls through to the router if it can't build an answer.
    replyText = profileReadback;
  } else if (
    looksLikeRevertRequest(body) &&
    (revertReply = await revertLastWeeklyAdjustment(athleteId)) !== null
  ) {
    // KER-79 (Phase 2): runner is undoing a coach-applied weekly adjustment
    // ("keep it as it was"). Restore the pre-change plan snapshot. Only fires
    // when there's a recent applied adjustment to revert; otherwise the cheap
    // regex short-circuits to null and we fall through to routing.
    replyText = revertReply;
  } else if (
    looksLikeWeekReviewRequest(body) &&
    (weeklyEval = await buildWeeklyEvaluation(athleteId, { messageId })) !== null
  ) {
    // KER-79 (Phase 2): "how did my week go?" → the coach evaluation grounded
    // in computed adherence + week signals. Read-only on a reactive ask: we
    // don't mutate the plan here (the proactive end-of-week path is where a
    // coach-decided adjustment is applied). Falls through to the router if
    // there's no plan to evaluate (buildWeeklyEvaluation returns null).
    replyText = weeklyEval.message;
  } else if (
    looksLikeTimezoneChange(body) &&
    (locChange = await extractLocationFromMessage({
      athleteId,
      messageId,
      body,
    })) !== null
  ) {
    // F8d + KER-78: runner is correcting their location. A permanent move
    // ("I now live in NYC") updates the home-city SSOT + timezone; a
    // temporary trip ("I'm in Tokyo this week") updates only the timezone
    // and preserves home. If extraction returns null (e.g. "I'm in pain"),
    // the && short-circuits and we fall through to normal routing — no
    // message gets swallowed.
    replyText = await applyLocationChange(athleteId, locChange);
  } else if (
    looksLikeReminderRequest(body) &&
    (reminderReq = classifyPrefsReply(body)).kind !== "ambiguous"
  ) {
    // RC3 (v1.3): runner is setting/changing a reminder in normal chat
    // ("remind me at 6am", "night before 9pm", "turn off reminders") —
    // not just in the post-plan prompt. Route to the prefs capture so
    // reminders are settable anytime. An ambiguous "can you remind me?"
    // (no time) short-circuits and falls through to the expert router,
    // which is now capability-aware and will ask for a time.
    if (reminderReq.kind === "decline") {
      await db
        .update(athletes)
        .set({ reminderPrefs: DECLINED_PREFS })
        .where(eq(athletes.id, athleteId));
      replyText = REMINDER_DECLINED_REPLY;
    } else {
      await db
        .update(athletes)
        .set({
          reminderPrefs: {
            enabled: true,
            time_local: reminderReq.time_local,
            timing: reminderReq.timing,
          },
        })
        .where(eq(athletes.id, athleteId));
      replyText = REMINDER_CAPTURED_REPLY(reminderReq.time_local, reminderReq.timing);
    }
  } else if (
    getPendingChoice(history)?.question_id === "caloffer" &&
    matchFreeText(Q_CAL_OFFER, body) !== null
  ) {
    // Post-plan calendar offer answered.
    const choice = matchFreeText(Q_CAL_OFFER, body);
    await resolvePendingChoice(athleteId, "caloffer");
    if (choice === "add_calendar") {
      replyText =
        (buildCalendarExportReply(athleteId, history) ?? CAL_NOT_CONFIGURED_REPLY) +
        REMINDER_PROMPT;
    } else {
      replyText = CAL_LATER_REPLY + REMINDER_PROMPT;
    }
  } else if (looksLikeCalendarResetRequest(body)) {
    // "Reset my calendar link" — revoke every previously shared feed URL.
    replyText = await resetCalendarFeed(athleteId);
  } else if (looksLikeCalendarExportRequest(body) && getStoredPlan(history)) {
    // "Add my plan to my calendar" — deterministic capability, no LLM (the
    // June bug was the model OFFERING calendar writes it couldn't do).
    replyText =
      buildCalendarExportReply(athleteId, history) ?? CAL_NOT_CONFIGURED_REPLY;
  } else if (
    getPendingChoice(history)?.question_id === "calib" &&
    matchFreeText(Q_CALIB, body) !== null
  ) {
    // Existing athlete answering the quick-calibration offer.
    const choice = matchFreeText(Q_CALIB, body);
    await resolvePendingChoice(athleteId, "calib");
    if (choice === "set_style") {
      await db
        .update(athletes)
        .set({ athleticHistory: { ...history, prefs_state: "coach" } })
        .where(eq(athletes.id, athleteId));
      replyText = MSG_COACH_QUESTION;
      replyChoices = Q_COACH;
    } else {
      replyText = "No problem — say \"set my style\" anytime.";
    }
  } else if (detectPrefEdit(body) !== null) {
    // "be more brief" / "harder on me" / "/settings" — preferences are living
    // state. Enum-constrained writes only (never LLM-extracted free text).
    const edit = detectPrefEdit(body)!;
    if (edit.kind === "open_settings") {
      await db
        .update(athletes)
        .set({ athleticHistory: { ...history, prefs_state: "coach" } })
        .where(eq(athletes.id, athleteId));
      replyText = MSG_COACH_QUESTION;
      replyChoices = Q_COACH;
    } else {
      replyText = await applyPrefEdit(athleteId, edit);
    }
  } else if (looksLikeGarminConnect(body)) {
    // Garmin is founder-only today (unofficial sidecar) — interest becomes a
    // waitlist signal for the source-agnostic ingestion track, not a dead end.
    replyText = await recordGarminInterest(athleteId);
  } else if (looksLikeStravaConnect(body)) {
    // Explicit Strava intent — honest reply (API paywalled June 2026): what
    // works today + the Garmin waitlist. Founder's existing connection still
    // gets the "already connected" answer.
    const status = await getStravaConnectStatus(athleteId);
    replyText = buildConnectReply(status);
  } else {
    // Normal expert routing branch.
    // Show the native "typing…" indicator immediately — multi-domain routing
    // can take 10-25s, so the runner needs a signal that MARP is on it.
    fireTypingIndicator(inboundSid);
    const memory = await getMemoryContext(athleteId);
    // v1.3 (A2): classify once up front so we can intercept a plan-edit
    // before the expensive expert pipeline. The routing is passed into
    // route() below so we never classify twice.
    const routing = await classify(body, { athleteId, messageId });

    if (routing.planEdit && getStoredPlan(history)) {
      // v1.3 (A1): runner wants to change their existing plan. Apply the
      // edit via targeted mutation (Sonnet), save, show the new version.
      const result = await adjustPlan({ athleteId, messageId, editRequest: body });
      if (result.ok) {
        await saveAthletePlan(athleteId, result.plan);
        // Feed staleness policy: a subscribed calendar picks the change up on
        // its next poll — say so, don't let the athlete wonder.
        const feedNote =
          history.calendar_connected_at !== undefined
            ? "\n\n(Your calendar feed picks this up within a day.)"
            : "";
        replyText =
          "Done — updated your plan. Here's the new version:\n\n" +
          renderPlanSummary(result.plan) +
          feedNote;
      } else {
        // no_plan is guarded above; this is the parse-failure path.
        replyText =
          "I couldn't apply that change cleanly. Try rephrasing it — " +
          "e.g. \"move my long run to Saturday\" or \"make week 3 easier\".";
      }
    } else {
      const result = await route({
        message: body,
        athleteId,
        messageId,
        contextSummary: memory.text,
        precomputedRouting: routing,
      });
      replyText = result.finalText.trim();
      routerFrame = result.frame;
    }

    // Migration beat (once): an athlete from before the preference era gets
    // the quick-calibration offer — AFTER their actual question is answered,
    // never instead of it, and never stapled to a safety referral.
    if (
      getPrefsState(history) === undefined &&
      !getCoachPrefs(history).coaching_style &&
      history.coach_prefs_offer_at === undefined &&
      !safetyReferral
    ) {
      await db
        .update(athletes)
        .set({
          athleticHistory: {
            ...history,
            coach_prefs_offer_at: new Date().toISOString(),
          },
        })
        .where(eq(athletes.id, athleteId));
      replyText += MSG_CALIB_OFFER;
      replyChoices = Q_CALIB;
    }
  }

  if (!replyText) {
    console.error(`processIncoming: empty reply for message ${messageId}`);
    return;
  }

  // Signature-driven button attachment: any branch whose reply carries the
  // calendar offer or the reminder ask gets the matching buttons, without
  // every plan-creating call site having to thread a choices value out.
  if (!replyChoices && replyText.includes(CAL_OFFER_SIGNATURE)) {
    replyChoices = Q_CAL_OFFER;
  }
  if (!replyChoices && replyText.includes(REMINDER_PROMPT_SIGNATURE)) {
    replyChoices = Q_REMINDER;
  }

  // S1: a Tier-1 referral prepends a hard referral to whatever reply the
  // normal flow produced (onboarding, coaching, pivot, etc.). Emergencies
  // already short-circuited above and never reach here.
  const finalReply = safetyReferral + replyText;

  const { outboundMessageId } = await sendAndPersist(
    athleteId,
    athleteRow.phone,
    finalReply,
    replyChoices,
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
  _phone: string,
  body: string,
  choices?: ChoiceQuestion,
): Promise<{ outboundMessageId: string | null }> {
  // Route via the channel router (WhatsApp or Telegram per MESSAGING_CHANNEL).
  // deliver() resolves the athlete's contact ids itself, so _phone is no longer
  // needed here (kept in the signature for call-site compatibility).
  let result: Awaited<ReturnType<typeof deliver>>;
  try {
    result = await deliver(athleteId, body, choices ? { choices } : undefined);
  } catch (err) {
    if (err instanceof TwilioSendError) {
      console.error(`Send failed (${err.status}): ${err.body.slice(0, 200)}`);
    } else {
      console.error("Send threw:", (err as Error).message);
    }
    return { outboundMessageId: null };
  }
  if (!result) return { outboundMessageId: null };

  // Persist the RENDERED body — what the athlete actually saw, numbered-text
  // fallback included — so lastOutbound signature checks stay honest (eng
  // amendment 4). The Twilio SID column only holds Twilio ids; Telegram ids
  // live in the channel.
  const [inserted] = await db
    .insert(messages)
    .values({
      athleteId,
      direction: "out",
      body: result.renderedBody,
      channel: result.channel,
      twilioMessageSid:
        result.channel === "whatsapp" ? result.providerMessageId : null,
    })
    .returning({ id: messages.id });

  // Open the pending question: the server-side truth that makes double-taps
  // idempotent and lets a typed answer retire the live keyboard.
  if (choices) {
    await setPendingChoice(athleteId, {
      question_id: choices.id,
      tg_message_id: result.keyboardSent ? result.providerMessageId : null,
      asked_at: new Date().toISOString(),
    });
  }

  return { outboundMessageId: inserted?.id ?? null };
}
