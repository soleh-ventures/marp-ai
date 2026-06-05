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
// F4-a (v1.2): coarse complexity tier driving model selection.
//   small_talk — greetings, thanks, acks, logistics; no coaching needed.
//                Answered by a single cheap Haiku reply, no expert pipeline.
//   simple / coaching — a real question; runs the full Sonnet pipeline.
// Defaults to "coaching" when absent — conservative escalation means a
// real question never gets mis-tiered down to the cheap path.
export type Complexity = "small_talk" | "simple" | "coaching";

export type Routing = {
  domains: Domain[];
  confidence: number;
  rationale: string;
  complexity: Complexity;
  // ET5: the runner's message likely needs the reply to present a fork
  // (alternative paths). Domain / synth will emit a decision_frame in
  // their output when this is true.
  isFork: boolean;
  // ET5 placeholder: the matched option key if the runner's message
  // resolves an open pending decision. The canonical match is done by
  // the binder (ET7) — the classifier emits null here for v1.
  resolvesDecision: string | null;
};

// ET6: structured fork payload emitted by domain / synthesizer when
// is_fork = true. Persisted into pending_decisions; the binder (ET7)
// uses option.key to mark resolution.
export type DecisionFrameOption = {
  key: string;
  label: string;
  action_hint?: string;
};
export type DecisionFrame = {
  question: string;
  options: DecisionFrameOption[];
};

// One domain expert's response. Kept separate from final synthesizer
// output so the synthesizer (and tests) can inspect each contribution.
// ET6: domain may emit a decision_frame alongside its text.
export type DomainAnswer = {
  domain: Domain;
  text: string;
  frame?: DecisionFrame;
};

// What the orchestrator returns to the webhook reply path. Includes the
// full audit trail so we can render it in /observability later.
export type RouterResult = {
  routing: Routing;
  domainAnswers: DomainAnswer[];
  finalText: string;
  // ET6: the structured frame the runner-facing reply represents.
  // Populated when routing.isFork = true and a domain / synthesizer
  // emitted a parseable frame; null when no fork was offered or the
  // frame couldn't be parsed even after a retry.
  frame: DecisionFrame | null;
  // Number of LLM calls actually executed: 2 (classifier + 1 domain) for
  // single-domain queries, 1 + N + 1 for multi-domain. Increments by 1
  // for each one-shot frame-retry call.
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
