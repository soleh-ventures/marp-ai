// Dormancy challenge: state and pattern detection for the 90-day
// re-auth prompt. See src/services/dormancy.ts for the threshold and
// archive helper.
//
// The prompt language is deliberately NEUTRAL — no name, no training
// stats, no race info. A recycled-number recipient learns nothing about
// the previous owner from the wording.

export const DORMANCY_CHALLENGE_PROMPT =
  "It's been a while since this conversation last had activity. " +
  "If this is the same person who was using MARP before, reply *YES* to pick up where you left off. " +
  "If you're new — or just want a clean slate — reply *NEW* to start fresh.";

// Sent after the runner picks NEW; the previous athlete row is now
// archived. The next inbound message creates a brand-new athlete and
// kicks off onboarding from scratch.
export const DORMANCY_RESTART_MESSAGE =
  "Got it — starting fresh. Send me any message to begin.";

// Sent after the runner picks YES; their old context is restored.
// Brief acknowledgement only — the next exchange will carry whatever
// they actually want to talk about.
export const DORMANCY_RESUME_MESSAGE =
  "Welcome back. I've got your training context loaded.";

// Repeated if the runner replies with anything other than YES / NEW
// after the challenge. We re-send the prompt rather than guess.
export const DORMANCY_RECHALLENGE_HINT =
  "I didn't catch that. " + DORMANCY_CHALLENGE_PROMPT;

export type DormancyResponse = "resume" | "restart" | "unclear";

export function classifyDormancyResponse(message: string): DormancyResponse {
  const t = message.trim().toUpperCase();
  if (t === "YES" || t === "RESUME") return "resume";
  if (t === "NEW" || t === "RESTART" || t === "FRESH") return "restart";
  return "unclear";
}
