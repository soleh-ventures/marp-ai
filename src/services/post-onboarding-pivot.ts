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
export const PIVOT_QUESTION_SIGNATURE = "Reply (a) or (b) to start";

export const PIVOT_QUESTION =
  "\n\nLast thing before we start — your training plan. Two options:\n" +
  "(a) You already have one → paste it and I'll coach you through it\n" +
  "(b) I build you a fresh plan, tailored to everything you just told me\n\n" +
  "👉 " +
  PIVOT_QUESTION_SIGNATURE +
  ".\nNot sure? Go with (b) — I've just got your goal, fitness, and injury " +
  "history, so I can build a plan around you specifically, not a generic template.";

export const PIVOT_REPLY_BYO =
  "Great — paste your plan in chat. Week-by-week or a summary both work; " +
  "I'll capture the structure and we'll coach from it. If it's long, you can " +
  "also send it as a file (📎) — a photo or screenshot, PDF, Word, Excel, or " +
  ".txt — or split it into a few messages. Take your time.";

export const PIVOT_REPLY_BUILD =
  "Great — I'll build one with you. We'll start with the macro shape " +
  "(weeks, peak mileage, phases), then drill into weekly cadence, then " +
  "daily sessions. Each step takes a couple minutes. Ready when you are.";

// Classifier — high-precision for the two paths. Falls back to "other"
// for anything ambiguous so the runner isn't trapped.
//
// Two layers:
//   1. Descriptive intent ("I have a plan" / "build me one") — matches
//      regardless of any a/b letter.
//   2. Letter / ordinal selection. We're only ever called when the runner
//      is replying to the "(a) or (b)" prompt, so a reply that boils down
//      to a single option letter — even wrapped in selection filler like
//      "let's do a", "go with b", "option a" — IS the choice. This is what
//      fixes the old bug where only a BARE "a"/"b" matched and natural
//      phrasings like "lets do with a" fell through to the expert router
//      (which then replied "not sure what you mean by 'a'").
export type PivotChoice = "byo" | "build" | "other";

const BYO_DESCRIPTIVE = [
  /\b(have|got)\s+(a|one|my)\s+(plan|training|own)/i,
  /\b(already|existing)\s+(have|got|use)\b/i,
  /\bcoach\s+me\s+through\b/i,
  /\bbring\s+(my|own)\b/i,
];

// RC1: target PLAN building specifically. The old pattern required an
// article right after the verb so "build training plan" missed; the naive
// fix ("build my …") wrongly caught coaching questions like "build my base".
// So: a build verb tied to "plan", or "build/make it/one" (the plan in
// pivot context), or "from scratch", or "you build".
const BUILD_DESCRIPTIVE = [
  /\b(build|make|create|design|generate)\b.{0,25}\bplan\b/i,
  /\b(build|make|create|generate)\s+(it|one)\b/i,
  /\bfrom\s+scratch\b/i,
  /\byou\s+(build|make|create|design)\b/i,
];

// Selection filler — words people wrap around the option letter when
// choosing ("let's do option a please"). Stripping these leaves just the
// letter when the message is genuinely a choice.
const SELECTION_FILLER = new Set([
  "lets", "let", "do", "doing", "go", "going", "with", "the", "option",
  "options", "choice", "choose", "choosing", "pick", "picking", "take",
  "taking", "select", "want", "wanna", "gimme", "give", "me", "i", "ill",
  "id", "just", "please", "pls", "ok", "okay", "sure", "yeah", "yep", "yes",
  "that", "one", "number", "for", "is", "it", "my", "plan",
]);

// Reduce a reply to a single option letter when that's all it amounts to
// after dropping selection filler. Returns null when the message carries
// real content beyond the choice (e.g. a question) so it routes onward.
function extractChoiceLetter(body: string): "a" | "b" | null {
  const tokens = body
    .toLowerCase()
    // Drop apostrophes first so contractions collapse to single filler
    // tokens ("let's" → "lets", "i'll" → "ill") instead of leaving stray
    // fragments ("s", "ll") that defeat the single-letter check.
    .replace(/['’]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !SELECTION_FILLER.has(t));
  if (tokens.length === 1 && (tokens[0] === "a" || tokens[0] === "b")) {
    return tokens[0] as "a" | "b";
  }
  return null;
}

// Synchronous, keyword-level read. As of the adaptive-pivot fix this is no
// longer the primary decision-maker — process-incoming reads intent with an
// LLM (pivot-intent.ts) so MARP adapts to any phrasing. This stays as the cheap
// gate for the RC1 fallback (deciding whether a planless runner's message even
// LOOKS like a pivot reply worth handling) and as the deterministic fallback
// when the LLM read fails. So it must stay conservative: prefer "other" over a
// wrong guess.
export function classifyPivotReply(body: string): PivotChoice {
  // An explicit decorated option marker at the very start wins, even with
  // trailing text: "(b) but my first day should be June 3rd" is a clear (b).
  // Note we only honour DECORATED letters here ("(b)", "b)", "b.") — a bare
  // leading "a"/"b" is too easily an article ("a tempo run") and is left to the
  // filler-strip extractor below, which requires the whole message to reduce to
  // the letter.
  const explicit = body.match(/^\s*(?:\(([ab])\)|([ab])[).:])/i);
  if (explicit) {
    const marker = (explicit[1] ?? explicit[2] ?? "").toLowerCase();
    if (marker === "a") return "byo";
    if (marker === "b") return "build";
  }

  if (BYO_DESCRIPTIVE.some((re) => re.test(body))) return "byo";
  if (BUILD_DESCRIPTIVE.some((re) => re.test(body))) return "build";

  const letter = extractChoiceLetter(body);
  if (letter === "a") return "byo";
  if (letter === "b") return "build";

  // Ordinal phrasings — "the first one" / "second option". The ordinal must be
  // BOUND to an option word; a bare /first|second/ test mis-fired on temporal
  // language ("my first day of training" → wrongly read as option a, the
  // original bug). Only when exactly one side is referenced (avoid "first or
  // second?").
  const firstOpt =
    /\b(first|1st)\s+(option|one|choice)\b|\b(option|choice)\s+(one|1|first)\b/i.test(
      body,
    );
  const secondOpt =
    /\b(second|2nd)\s+(option|one|choice)\b|\b(option|choice)\s+(two|2|second)\b/i.test(
      body,
    );
  if (firstOpt && !secondOpt) return "byo";
  if (secondOpt && !firstOpt) return "build";

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
