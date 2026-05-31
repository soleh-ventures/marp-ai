// Two-phase deletion intent detection.
//
// Phase 1 (request): runner says something like "delete my account".
//   → MARP replies with the DELETION_CONFIRMATION_PROMPT.
//
// Phase 2 (confirm): runner replies "YES DELETE" (exact, case-insensitive)
//   → confirmation valid iff the *previous outbound* was the prompt above.
//
// The state lives in the messages table — no extra column needed. The
// caller looks up the last outbound message body and checks whether it
// matches DELETION_CONFIRMATION_PROMPT before treating "YES DELETE" as
// a deletion confirmation.

const DELETION_REQUEST_PATTERNS = [
  /\bdelete\s+(my\s+)?(account|data|profile|me|everything)\b/i,
  /\bforget\s+(me|everything\s+about\s+me)\b/i,
  /\bremove\s+(my\s+)?(account|data|profile)\b/i,
  /\berase\s+(my\s+)?(account|data|profile)\b/i,
  /\bwipe\s+(my\s+)?(account|data|profile)\b/i,
];

export function looksLikeDeletionRequest(message: string): boolean {
  return DELETION_REQUEST_PATTERNS.some((re) => re.test(message));
}

// Exact-string confirmation chosen for two reasons:
//   1. Unlikely to be typed accidentally during normal training chat
//   2. Easy for the runner to recall after reading the prompt
// Case-insensitive to be forgiving of mobile autocorrect / shift state.
export function isDeletionConfirmation(message: string): boolean {
  return message.trim().toUpperCase() === "YES DELETE";
}

export const DELETION_CONFIRMATION_PROMPT =
  "Are you sure? This permanently deletes your training history, Strava " +
  "connection, and every conversation we've had. Reply *YES DELETE* (in " +
  "all caps) within a few minutes to confirm. Anything else cancels.";

export const DELETION_SUCCESS_MESSAGE =
  "Your MARP account and all associated data have been deleted. Take care.";
