// S1+ (KER-29) — deterministic safety floor.
//
// The LLM triage is recall-biased but still probabilistic: it can miss,
// mis-parse, or be unavailable. For a guardrail that has to hold on the
// most crucial messages, we add a DETERMINISTIC layer that runs with no
// LLM at all. It matches a tight, high-precision set of unambiguous
// crisis/red-flag phrases and can only ESCALATE the final tier, never
// lower it. This layer holds even when the model fails — that's the whole
// point: the worst cases must never depend on an LLM being available or
// correct.
//
// Precision over recall HERE (the LLM provides recall): every pattern
// must be something almost no ordinary running message would say.

import type { SafetyTriage, SafetyTier } from "./triage.js";

type Rule = { re: RegExp; tier: SafetyTier; category: string };

// Tier 0 — life-threatening, unambiguous. These must always short-circuit.
const EMERGENCY_RULES: Rule[] = [
  {
    re: /\b(kill(ing)? myself|end(ing)? my life|take my own life|want(ing)? to die|wanna die|don'?t want to (live|be alive|be here)|suicidal|suicide|harm(ing)? myself|hurt(ing)? myself|cut(ting)? myself)\b/i,
    tier: "emergency",
    category: "self_harm",
  },
  {
    re: /\b(can'?t|cannot|couldn'?t) (breathe|breath)\b|\bstruggling to breathe\b|\bgasping for (air|breath)\b/i,
    tier: "emergency",
    category: "breathing",
  },
  {
    re: /\b(collapsed|passed out|blacked out|fainted|unconscious|unresponsive)\b/i,
    tier: "emergency",
    category: "collapse",
  },
];

// Tier 1 — red flags that must reach a professional. Deterministic floor
// is "referral"; the LLM may upgrade chest pain etc. to emergency.
const REFERRAL_RULES: Rule[] = [
  {
    // "chest pain", "chest feels tight", "tightness in my chest", "tight
    // chest" — but NOT "chest workout … legs hurt" (proximity-bounded).
    re: /\bchest\b.{0,15}\b(pain|pains|tight|tightness|pressure|hurts?|hurting)\b|\b(pain|tight|tightness|pressure)\b.{0,12}\bchest\b/i,
    tier: "referral",
    category: "injury_red_flag",
  },
  {
    re: /\bmak(e|ing) myself (throw up|sick|vomit)\b|\bforce myself to (throw up|vomit)\b|\bpurg(e|ing)\b|\b(throw|threw) up after (eating|i eat|meals)\b/i,
    tier: "referral",
    category: "ed_reds",
  },
  {
    re: /\b(haven'?t had|lost|missing|stopped getting|no) (my )?period\b|\bperiod (stopped|has stopped)\b|\bamenorrh?ea\b/i,
    tier: "referral",
    category: "ed_reds",
  },
  {
    re: /\b(skip(ping)? meals|starv(e|ing) myself|barely eat(ing)?|not eat(ing)? (enough|much)|restrict(ing)? (food|calories|eating))\b/i,
    tier: "referral",
    category: "ed_reds",
  },
];

// Run the deterministic screen. Returns the HIGHEST tier matched (none if
// nothing matches). Pure + synchronous — no LLM, never throws.
export function screenDeterministic(message: string): SafetyTriage {
  for (const r of EMERGENCY_RULES) {
    if (r.re.test(message)) {
      return { tier: "emergency", category: r.category, reason: "deterministic guardrail" };
    }
  }
  for (const r of REFERRAL_RULES) {
    if (r.re.test(message)) {
      return { tier: "referral", category: r.category, reason: "deterministic guardrail" };
    }
  }
  return { tier: "none", category: "none", reason: "" };
}

const RANK: Record<SafetyTier, number> = { none: 0, referral: 1, emergency: 2 };

// Combine the deterministic floor with the LLM result: take the higher
// severity. The floor can only escalate. When the floor wins (>= the LLM),
// its category/reason are used.
export function combineTriage(
  floor: SafetyTriage,
  llm: SafetyTriage,
): SafetyTriage {
  return RANK[floor.tier] >= RANK[llm.tier] ? floor : llm;
}
