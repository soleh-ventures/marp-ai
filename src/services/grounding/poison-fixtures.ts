// KER-77 (Grounded Coach, Phase 0 de-risk) — location-poisoning fixtures.
//
// The plan's premise is "fix the data model, not the prompt." This eval
// tests the half that's NOT a data-model fix: even with a correct SSOT
// (the "Now (ground truth … Europe/Berlin)" line), a stale "I moved to
// Tokyo" sentence still sits in the last-20-message window that
// formatContext dumps verbatim (retrieve.ts) and CANNOT be stripped (it's
// real conversation). The only guard today is the soft "ignore any
// conflicting city" instruction — the exact thing the bug evidence blames.
//
// Each fixture builds a PRODUCTION-FAITHFUL context via formatContext:
// ground truth = Berlin, but a Tokyo claim is planted in the message log
// (and sometimes the athletic_history JSON). We then ask the real domain
// LLM where the runner lives and measure how often it answers Tokyo.

import { formatContext } from "../../memory/retrieve.js";

const BERLIN_NOW = {
  date: "2026-06-08",
  weekday: "monday",
  time: "09:00",
  timezone: "Europe/Berlin",
} as const;

type Msg = { direction: "in" | "out"; body: string; receivedAt: Date };

function ctx(opts: {
  messages: Msg[];
  athleticHistory?: Record<string, unknown> | null;
}): string {
  return formatContext({
    name: "Kemal",
    locale: "en",
    // KER-78: the home-city SSOT now says Berlin. Pre-fix (no homeCity) the
    // ground-truth line only carried the timezone and the stale "Tokyo" in
    // the message log poisoned 44% of clear cases (the KER-77 baseline).
    // With the SSOT populated, this eval is Phase 1's regression gate.
    homeCity: "Berlin",
    athleticHistory: opts.athleticHistory ?? { experience: "intermediate" },
    flags: [],
    block: undefined,
    messages: opts.messages,
    zonedToday: { ...BERLIN_NOW },
  });
}

// Build a recent-message window. `staleAt` controls recency (older =
// further up the 20-message window). All windows end with neutral chatter
// so the Tokyo claim isn't the literal last line (the realistic case).
function window(tokyoClaim: string, claimDir: "in" | "out" = "in"): Msg[] {
  const base = new Date("2026-05-01T08:00:00Z");
  const day = 86400000;
  return [
    { direction: "in", body: tokyoClaim, receivedAt: new Date(base.getTime()) },
    { direction: "out", body: "Got it, noted.", receivedAt: new Date(base.getTime() + day) },
    { direction: "in", body: "did an easy 8k this morning", receivedAt: new Date(base.getTime() + 2 * day) },
    { direction: "out", body: "Nice, how did it feel?", receivedAt: new Date(base.getTime() + 3 * day) },
    { direction: "in", body: "legs felt good, breathing easy", receivedAt: new Date(base.getTime() + 4 * day) },
  ].map((m) => ({ ...m, direction: m.direction as "in" | "out" }));
}

export type PoisonFixture = {
  name: string;
  question: string;
  context: string;
  home: string; // correct answer
  poison: string; // the stale city the LLM must NOT adopt
  // "clear" = the runner is unambiguously home; saying Tokyo is a hard
  // failure. "ambiguous" = a genuine judgment call (current trip); tracked
  // separately, not counted as a hard miss.
  kind: "clear" | "ambiguous";
};

const Q = "Which city do I currently live in? Answer in one short sentence.";

export const POISON_FIXTURES: PoisonFixture[] = [
  {
    name: "moved_back_old_claim",
    question: Q,
    // They said "moved to Tokyo" weeks ago but the SSOT is now Berlin
    // (they moved back). Ground truth must win.
    context: ctx({ messages: window("I just moved to Tokyo for work") }),
    home: "Berlin",
    poison: "Tokyo",
    kind: "clear",
  },
  {
    name: "past_race_trip",
    question: Q,
    context: ctx({ messages: window("I was in Tokyo last week for a race") }),
    home: "Berlin",
    poison: "Tokyo",
    kind: "clear",
  },
  {
    name: "future_intent",
    question: Q,
    context: ctx({ messages: window("I'm thinking of moving to Tokyo next year") }),
    home: "Berlin",
    poison: "Tokyo",
    kind: "clear",
  },
  {
    name: "stale_city_in_history",
    question: Q,
    context: ctx({
      messages: window("Tokyo has been great for training"),
      athleticHistory: { experience: "intermediate", city: "Tokyo" },
    }),
    home: "Berlin",
    poison: "Tokyo",
    kind: "clear",
  },
  {
    name: "repeated_tokyo_mentions",
    question: Q,
    context: ctx({
      messages: [
        { direction: "in", body: "loving the runs around Tokyo", receivedAt: new Date("2026-05-01T08:00:00Z") },
        { direction: "out", body: "Sounds great.", receivedAt: new Date("2026-05-02T08:00:00Z") },
        { direction: "in", body: "Tokyo humidity is brutal though", receivedAt: new Date("2026-05-03T08:00:00Z") },
        { direction: "out", body: "Hydrate well.", receivedAt: new Date("2026-05-04T08:00:00Z") },
        { direction: "in", body: "ran along the Tokyo bay path", receivedAt: new Date("2026-05-05T08:00:00Z") },
      ],
    }),
    home: "Berlin",
    poison: "Tokyo",
    kind: "clear",
  },
  {
    name: "marp_said_tokyo",
    question: Q,
    // MARP itself referenced Tokyo in a past turn (outbound) — does the
    // model trust its own stale claim over the ground-truth line?
    context: ctx({
      messages: [
        { direction: "out", body: "Since you're in Tokyo, the heat matters.", receivedAt: new Date("2026-05-01T08:00:00Z") },
        { direction: "in", body: "yeah", receivedAt: new Date("2026-05-02T08:00:00Z") },
        { direction: "in", body: "did 10k tempo", receivedAt: new Date("2026-05-03T08:00:00Z") },
        { direction: "out", body: "Strong session.", receivedAt: new Date("2026-05-04T08:00:00Z") },
        { direction: "in", body: "felt great", receivedAt: new Date("2026-05-05T08:00:00Z") },
      ],
    }),
    home: "Berlin",
    poison: "Tokyo",
    kind: "clear",
  },
  {
    name: "current_trip_ambiguous",
    question: Q,
    // Genuine judgment call: they're physically in Tokyo this week but
    // live in Berlin. Tracked separately — not a hard miss either way.
    context: ctx({ messages: window("I'm in Tokyo this week for a work trip") }),
    home: "Berlin",
    poison: "Tokyo",
    kind: "ambiguous",
  },
  {
    name: "moved_back_explicit",
    question: Q,
    context: ctx({
      messages: [
        { direction: "in", body: "I moved to Tokyo in January", receivedAt: new Date("2026-05-01T08:00:00Z") },
        { direction: "out", body: "Noted.", receivedAt: new Date("2026-05-02T08:00:00Z") },
        { direction: "in", body: "actually I'm back in Berlin now", receivedAt: new Date("2026-05-03T08:00:00Z") },
        { direction: "out", body: "Welcome back!", receivedAt: new Date("2026-05-04T08:00:00Z") },
        { direction: "in", body: "easy 6k today", receivedAt: new Date("2026-05-05T08:00:00Z") },
      ],
    }),
    home: "Berlin",
    poison: "Tokyo",
    kind: "clear",
  },
  {
    name: "visiting_phrasing",
    question: Q,
    context: ctx({ messages: window("visiting Tokyo for a few days") }),
    home: "Berlin",
    poison: "Tokyo",
    kind: "clear",
  },
  {
    name: "history_and_message",
    question: Q,
    context: ctx({
      messages: window("the Tokyo running club is so welcoming"),
      athleticHistory: { experience: "intermediate", location: "Tokyo, Japan" },
    }),
    home: "Berlin",
    poison: "Tokyo",
    kind: "clear",
  },
];
