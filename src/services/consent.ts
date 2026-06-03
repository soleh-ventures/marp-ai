import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { athletes } from "../db/schema.js";

// Pre-onboarding consent gate (GDPR Article 6 lawful basis).
//
// The runner's very first message triggers data collection — phone
// number gets persisted by findOrCreateByPhone before we've said a
// word. We can't legally start coaching without explicit informed
// consent, so this module gates everything downstream of the
// athlete-creation step.
//
// State machine (driven from athletes.consent_granted_at):
//
//   NULL + no consent message yet → send privacy notice, persist
//       nothing else. Return reply = the notice itself so the caller
//       can ship it and exit.
//
//   NULL + runner replies "yes" → set consent_granted_at = now(),
//       return reply = the welcome-handoff that pivots to onboarding.
//
//   NULL + runner replies "stop"/"no"/"opt out" → archive the athlete
//       (cascade-deletes the inbound message just persisted), return
//       reply = a respectful close.
//
//   NULL + runner says something else → re-send the notice (gently;
//       the runner probably didn't see it the first time).
//
//   populated → consent already granted; this branch is skipped and
//       the normal routing flow proceeds.
//
// Copy guidelines (locked in here so we don't drift across surfaces):
//   - Short. WhatsApp message, not a EULA.
//   - Lead with WHY we collect data — coaching context, nothing else.
//   - Surface the right to delete in the SAME message that asks for
//     consent. Runners shouldn't have to dig to find the off-switch.
//   - Warm, plain, no legalese. "We don't sell your data" rather than
//     "Data shall not be transferred to third parties for marketing."

export const PRIVACY_NOTICE =
  "Hi — welcome to MARP. Before we start, a quick honest note:\n\n" +
  "I save your messages, runs, and profile so I can coach you over time. " +
  "It's encrypted, stays with us, and never gets sold to anyone.\n\n" +
  "You can text \"delete my account\" anytime — instant wipe, no questions.\n\n" +
  "Reply YES to start. Reply STOP if this isn't for you.";

// Sent after the runner accepts the privacy notice. Combines the
// consent confirmation with the first onboarding question so the
// conversation doesn't stall waiting for the runner to take initiative
// — onboarding then handles the runner's answer on the next turn.
export const CONSENT_ACCEPTED_REPLY =
  "You're in. I'll ask a few quick questions to get your context, then we can dive in.\n\n" +
  "First — what's your name and what race or goal are you training for?";

export const CONSENT_DECLINED_REPLY =
  "All good — your data won't be stored. If you change your mind, text MARP again anytime.";

export const CONSENT_AMBIGUOUS_REPLY =
  "Just need a clear yes or no before we start.\n\n" + PRIVACY_NOTICE;

// Regex set chosen to be tight: "yes" plus very common phrasings that
// any reasonable runner might type instead. Anything else is treated
// as ambiguous and re-prompted — false positives here would mean we
// processed someone's data without consent, which is the exact thing
// we're trying to prevent.
const CONSENT_ACCEPT_PATTERNS = [
  /^\s*yes\b/i,
  /^\s*yeah\b/i,
  /^\s*yep\b/i,
  /^\s*sure\b/i,
  /^\s*ok\s*(go|let.?s\s+go)?\b/i,
  /^\s*i\s*agree\b/i,
  /^\s*agreed?\b/i,
  /^\s*sounds?\s+good\b/i,
];

const CONSENT_DECLINE_PATTERNS = [
  /^\s*stop\b/i,
  /^\s*no\b/i,
  /^\s*nope\b/i,
  /^\s*opt\s*out\b/i,
  /^\s*not\s+interested\b/i,
  /^\s*cancel\b/i,
];

export type ConsentDecision = "accept" | "decline" | "ambiguous";

export function classifyConsentReply(body: string): ConsentDecision {
  if (CONSENT_ACCEPT_PATTERNS.some((re) => re.test(body))) return "accept";
  if (CONSENT_DECLINE_PATTERNS.some((re) => re.test(body))) return "decline";
  return "ambiguous";
}

export async function recordConsentGranted(athleteId: string): Promise<void> {
  await db
    .update(athletes)
    .set({ consentGrantedAt: new Date() })
    .where(eq(athletes.id, athleteId));
}
