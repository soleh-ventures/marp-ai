// The six domain experts that make up the v1 brain. The classifier picks
// one or more of these per inbound message. Order in this list is the
// canonical order — used when persisting routing decisions for analytics.
export const DOMAINS = [
  "training",
  "nutrition",
  "injury",
  "mental",
  "recovery",
  "gear",
] as const;
export type Domain = (typeof DOMAINS)[number];

export function isDomain(s: string): s is Domain {
  return (DOMAINS as readonly string[]).includes(s);
}

// Routing decision produced by the classifier. `confidence` is the
// classifier's self-reported certainty (0..1) — useful for surfacing
// "I'm not sure I understand" handoffs in T9 onboarding.
export type Routing = {
  domains: Domain[];
  confidence: number;
  rationale: string;
};

// One domain expert's response. Kept separate from final synthesizer
// output so the synthesizer (and tests) can inspect each contribution.
export type DomainAnswer = {
  domain: Domain;
  text: string;
};

// What the orchestrator returns to the webhook reply path. Includes the
// full audit trail so we can render it in /observability later.
export type RouterResult = {
  routing: Routing;
  domainAnswers: DomainAnswer[];
  finalText: string;
  // Number of LLM calls actually executed: 2 (classifier + 1 domain) for
  // single-domain queries, 1 + N + 1 for multi-domain.
  llmCallCount: number;
};

export type RouterInput = {
  message: string;
  athleteId?: string;
  messageId?: string;
  // Memory-layer context (T7). For T5 this is just an optional string blob
  // that gets prepended to every domain prompt. T7 will give it structure.
  contextSummary?: string;
};
