// V5 (v1.1 flow redesign) — post-onboarding plan pivot.
//
// After onboarding wraps up, the runner has a goal but no plan anchor.
// User feedback: "ask me anything" leaves them adrift. Coaching needs
// a concrete next step.
//
// Pivot question (appended to onboarding wrap-up):
//
//   Two ways to start:
//   (a) You already have a training plan and want me to coach you through it
//   (b) You'd like me to build one from scratch
//   Just reply (a) or (b).
//
// On the next inbound, classify the runner's response:
//   - "a" / "have a plan" / "I've got one" → enter plan-ingest mode
//   - "b" / "build one" / "from scratch" / "you build it" → enter plan-build mode
//   - anything else → fall through to expert router (runner has a
//     question that isn't an a/b reply; don't trap them)
//
// State lives in athletes.athletic_history.pivot_state:
//   - undefined          → never asked (pre-onboarding-complete)
//   - "awaiting_choice"  → wrap-up sent, waiting for a/b
//   - "awaiting_plan"    → runner chose (a), waiting for the paste
//   - "build_pending"    → runner chose (b), V6 generator will pick up
//   - "done"             → plan captured / generated, normal routing resumes

import type { AthleticHistory } from "../flows/onboarding.js";

export type PivotState =
  | "awaiting_choice"
  | "awaiting_plan"
  | "build_pending"
  | "done";

// Visible signature used to detect "runner is replying to the pivot."
// Embedded literally in the wrap-up message; matched against
// lastOutbound. Keep short and stable — a rephrase here changes the
// detection behaviour.
export const PIVOT_QUESTION_SIGNATURE = "Just reply (a) or (b).";

export const PIVOT_QUESTION =
  "\n\nTwo ways to start:\n" +
  "(a) You already have a training plan and want me to coach you through it\n" +
  "(b) You'd like me to build one from scratch\n" +
  PIVOT_QUESTION_SIGNATURE;

export const PIVOT_REPLY_BYO =
  "Great — paste your plan in chat. Week-by-week or a summary both work; " +
  "I'll capture the structure and we'll coach from it. Take your time.";

export const PIVOT_REPLY_BUILD =
  "Great — I'll build one with you. We'll start with the macro shape " +
  "(weeks, peak mileage, phases), then drill into weekly cadence, then " +
  "daily sessions. Each step takes a couple minutes. Ready when you are.";

// Classifier — high-precision regex for the two paths. Falls back to
// "other" for anything ambiguous so the runner isn't trapped.
export type PivotChoice = "byo" | "build" | "other";

const BYO_PATTERNS = [
  /^\s*[a]\s*[\.\)]?\s*$/i,
  /\b(have|got)\s+(a|one|my)\s+(plan|training|own)/i,
  /\b(already|existing)\s+(have|got|use)\b/i,
  /\bcoach\s+me\s+through\b/i,
  /\bbring\s+(my|own)\b/i,
];

const BUILD_PATTERNS = [
  /^\s*[b]\s*[\.\)]?\s*$/i,
  /\b(build|make|create|design)\s+(one|a|me|the)\b/i,
  /\bfrom\s+scratch\b/i,
  /\byou\s+(build|make|create|design)\b/i,
  /\bgenerate\b.{0,15}\bplan\b/i,
];

export function classifyPivotReply(body: string): PivotChoice {
  if (BYO_PATTERNS.some((re) => re.test(body))) return "byo";
  if (BUILD_PATTERNS.some((re) => re.test(body))) return "build";
  return "other";
}

// Detect whether we're currently waiting for an a/b reply. Tied to
// lastOutbound containing the signature — robust to the LLM appending
// extra text around the wrap-up (which it sometimes does).
export function isAwaitingPivotChoice(
  lastOutboundBody: string | null,
  history: AthleticHistory,
): boolean {
  const state = (history.pivot_state as PivotState | undefined) ?? undefined;
  if (state === "awaiting_plan" || state === "build_pending" || state === "done") {
    return false;
  }
  return (
    lastOutboundBody !== null &&
    lastOutboundBody.includes(PIVOT_QUESTION_SIGNATURE)
  );
}

// Read the pivot_state out of athletic_history. Undefined means "never
// reached the pivot" (still pre-onboarding-complete).
export function getPivotState(history: AthleticHistory): PivotState | undefined {
  const state = history.pivot_state;
  if (
    state === "awaiting_choice" ||
    state === "awaiting_plan" ||
    state === "build_pending" ||
    state === "done"
  ) {
    return state;
  }
  return undefined;
}

// Returns the updated history object with pivot_state set. Caller is
// responsible for persisting.
export function withPivotState(
  history: AthleticHistory,
  state: PivotState,
): AthleticHistory {
  return { ...history, pivot_state: state };
}
