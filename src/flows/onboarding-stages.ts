// V3 (v1.1 flow redesign) — onboarding progress + per-stage rationale.
//
// The LLM still drives the conversation: it picks the next question
// and extracts data. This module owns the *static* tail that gets
// appended to every onboarding reply so the runner always knows:
//   1. WHY MARP is asking (rationale)
//   2. HOW MUCH is left (progress)
//
// User feedback that drove this: onboarding feels open-ended — no
// sense of how many questions remain, no explanation of why each
// question matters. Coaching is a trust exercise; if MARP asks a
// stranger about their injury history without context, it lands
// invasively. Two lines of static copy is the cheapest fix.
//
// Rationale copy is hardcoded (not LLM-generated) so it's consistent
// across runs. Progress math is from STAGE_INDEX below.

import type { OnboardingSection } from "./onboarding.js";

// 1-indexed position in the onboarding journey. "complete" sits past
// the productive stages so progress math can short-circuit.
export const STAGE_INDEX: Record<OnboardingSection, number> = {
  basics: 1,
  fitness: 2,
  goal: 3,
  lifestyle: 4,
  injury: 5,
  accountability: 6,
  complete: 7,
};

export const TOTAL_STAGES = 6;

type ProductiveStage = Exclude<OnboardingSection, "complete">;

// "Why I ask" — one short, concrete line per stage. No coaching jargon,
// no hedging. Each line names what MARP can do BETTER with this data,
// not what MARP can't do without it (anxious framing). Keep these
// under ~80 chars so the chat tail doesn't dominate the reply.
export const STAGE_RATIONALE: Record<ProductiveStage, string> = {
  basics:
    "lets me call you by name and ground every reply in who you are.",
  fitness:
    "tells me where you're starting from so the plan meets your real fitness.",
  goal:
    "anchors everything — pace, weekly mileage, taper all key off this.",
  lifestyle:
    "training that ignores life crashes against it. Work, travel, family all matter.",
  injury:
    "I won't push intensity through pain. Knowing this changes my advice.",
  accountability:
    "tells me how often you want to hear from me — daily nudges or just on demand.",
};

// Rough remaining-time estimate per stage. We deliberately under-
// promise: "~3 min" with friction beats "~1 min" with a stuck runner.
const TIME_LEFT: Record<ProductiveStage, string> = {
  basics: "~3 min left",
  fitness: "~3 min left",
  goal: "~2 min left",
  lifestyle: "~2 min left",
  injury: "~1 min left",
  accountability: "almost done",
};

// Builds the two-line tail to append to an onboarding reply. Returns
// null when the section is "complete" — the wrap-up reply doesn't
// need a progress indicator (it's the celebration message).
export function buildProgressTail(section: OnboardingSection): string | null {
  if (section === "complete") return null;
  const productive = section as ProductiveStage;
  const index = STAGE_INDEX[productive];
  const rationale = STAGE_RATIONALE[productive];
  const timeLeft = TIME_LEFT[productive];
  return (
    `\n\nWhy I ask: ${rationale}\n` +
    `Onboarding: ${index} of ${TOTAL_STAGES} (${timeLeft})`
  );
}

// Appends the tail to a reply if applicable. Centralised so callers
// don't have to remember the null-check.
export function appendProgressTail(
  reply: string,
  section: OnboardingSection,
): string {
  const tail = buildProgressTail(section);
  return tail ? reply + tail : reply;
}
