// S1 (KER-29) — scripted safety responses.
//
// Emergency (Tier 0) responses are region-aware: we pick the right
// emergency number from the runner's stored ISO country (F8b). When the
// country is unknown we give the two most useful defaults (112 / 911)
// rather than guessing. These are SCRIPTED — never LLM-generated — so a
// model failure can never garble an emergency instruction.
//
// Referral (Tier 1) notices are prepended to the normal coaching reply.

import type { SafetyTriage } from "./triage.js";

// ISO 3166-1 alpha-2 → local emergency number. 112 works across the EU/EEA
// and as a GSM fallback in many countries; we list the few big non-112
// regions explicitly and default everything else to 112.
const EMERGENCY_NUMBER: Record<string, string> = {
  US: "911",
  CA: "911",
  GB: "999 or 112",
  AU: "000",
  NZ: "111",
  JP: "119", // ambulance/fire in Japan
  ID: "112 or 118/119",
};

// EU/EEA + close neighbours where 112 is the standard emergency number.
const EU_112 = new Set([
  "DE", "FR", "ES", "IT", "NL", "BE", "PT", "AT", "IE", "PL", "SE", "DK",
  "FI", "NO", "CH", "CZ", "GR", "HU", "RO", "BG", "HR", "SK", "SI", "EE",
  "LV", "LT", "LU", "CY", "MT", "IS",
]);

export function emergencyNumberFor(country: string | null | undefined): string {
  const c = country?.toUpperCase();
  if (c && EMERGENCY_NUMBER[c]) return EMERGENCY_NUMBER[c] as string;
  if (c && EU_112.has(c)) return "112";
  // Unknown region — give both common numbers so the runner isn't stuck.
  return "your local emergency number (112 in Europe, 911 in the US/Canada)";
}

// The scripted Tier 0 message. Calm, direct, no coaching, no hedging.
export function emergencyResponse(country: string | null | undefined): string {
  const num = emergencyNumberFor(country);
  return (
    "This sounds like it could be a medical emergency. I'm an AI running " +
    "coach, not a medical service, so please stop and get real help now:\n\n" +
    `📞 Call ${num}, or go to the nearest emergency room.\n\n` +
    "If someone is with you, tell them what's happening. Your safety comes " +
    "before any run or plan — please reach out to emergency services right away."
  );
}

// Tier 1 referral notices, keyed by the classifier's category. Prepended
// to the normal coaching reply with a blank line between.
const REFERRAL_BY_CATEGORY: Record<string, string> = {
  ed_reds:
    "Before anything about training — what you're describing around food and " +
    "fuelling is something a doctor or a sports dietitian needs to look at, not " +
    "something I should coach you through alone. Please reach out to one; in many " +
    "places there are free eating-disorder helplines too. I'm still here for you.",
  pregnancy:
    "Since pregnancy changes what's safe to train, please check your plan with " +
    "your doctor or midwife before we push any load — I'll happily adjust around " +
    "whatever they advise.",
  injury_red_flag:
    "That doesn't sound like something to train through — pain at that level (or " +
    "a joint that gives way, night pain, numbness) needs a physio or doctor to " +
    "assess it in person. Please get it looked at; I can help you stay fit safely " +
    "around it once you have.",
  other_medical:
    "This is worth getting checked by a medical professional rather than managing " +
    "it through training alone. Please reach out to one — I'll work around whatever " +
    "they tell you.",
};

export function referralNotice(category: string): string {
  return REFERRAL_BY_CATEGORY[category] ?? REFERRAL_BY_CATEGORY.other_medical!;
}

// Convenience: given a triage result, the referral line to prepend (empty
// string when the tier isn't a referral, so callers can concatenate freely).
export function referralPrefixFor(triage: SafetyTriage): string {
  return triage.tier === "referral" ? `${referralNotice(triage.category)}\n\n` : "";
}
