// Post-onboarding preference edits — "everything is changeable later."
//
// Deterministic pattern → closed enum value. NEVER writes free text into
// coach_prefs: the calibration block in memory context renders these values
// into every system prompt, so an LLM-extracted write here would be a prompt
// injection channel (eng amendment 13). Patterns map straight to enum values;
// anything that doesn't match routes to normal chat.

import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { athletes } from "../../db/schema.js";
import { getAthleticHistory } from "../../flows/onboarding.js";
import {
  getCoachPrefs,
  type CoachingStyle,
  type ReplyStyle,
  type TrainingStyle,
} from "../../flows/preferences.js";

export type PrefEdit =
  | { kind: "coaching_style"; value: CoachingStyle }
  | { kind: "reply_style"; value: ReplyStyle }
  | { kind: "training_style"; value: TrainingStyle }
  | { kind: "open_settings" };

// Tight patterns, checked on SHORT messages only (long messages are almost
// always about training content, not settings — "the tempo felt really hard
// today, be honest, was that too much?" must not flip coaching style).
const MAX_LEN = 60;

export function detectPrefEdit(body: string): PrefEdit | null {
  const t = body.trim();
  if (t.length === 0 || t.length > MAX_LEN) return null;
  const s = t.toLowerCase();

  if (/^\/settings\b/.test(s) || /\b(set|change|update)\s+my\s+(style|preferences|prefs)\b/.test(s)) {
    return { kind: "open_settings" };
  }

  // Reply length.
  if (/\b(be\s+)?(more\s+)?(brief|briefer|shorter|concise)\b/.test(s) || /\bshorter\s+(replies|answers|messages)\b/.test(s)) {
    return { kind: "reply_style", value: "short" };
  }
  if (/\b(more\s+detail|longer\s+(replies|answers|messages)|more\s+explanation|explain\s+more\s+by\s+default)\b/.test(s)) {
    return { kind: "reply_style", value: "long" };
  }

  // Coaching style (the relationship).
  if (/\b(be\s+)?(harder|tougher|stricter)\s+on\s+me\b/.test(s) || /\bbe\s+my\s+director\b/.test(s)) {
    return { kind: "coaching_style", value: "director" };
  }
  if (/\b(be\s+)?(gentler|nicer|softer|kinder)\b/.test(s) || /\beasier\s+on\s+me\b/.test(s)) {
    return { kind: "coaching_style", value: "companion" };
  }

  // Training push. "push harder"/"ease off" are about the PLAN.
  if (/\b(push|train)\s+(me\s+)?harder\b/.test(s) || /\bmake\s+the\s+plan\s+harder\b/.test(s)) {
    return { kind: "training_style", value: "hard" };
  }
  if (/\b(ease|back)\s+off\b/.test(s) || /\bmake\s+the\s+plan\s+easier\b/.test(s)) {
    return { kind: "training_style", value: "easy" };
  }

  return null;
}

const CONFIRM: Record<string, Record<string, string>> = {
  coaching_style: {
    director: "Done — Director mode. I make the calls, you run them.",
    companion: "Done — Companion mode. At your side, not on your back.",
    partner: "Done — Partner mode. We decide together.",
  },
  reply_style: {
    short: "Done — short and sharp from here. Ask for detail whenever you want it.",
    long: "Done — full reasoning from here. Say \"shorter\" anytime.",
    balanced: "Done — balanced replies.",
  },
  training_style: {
    hard: "Done — plan runs harder from the next adjustment. I'll still flag the risks.",
    easy: "Done — easing the plan off. Consistency beats heroics.",
    balanced: "Done — balanced load.",
    aggressive: "Aggressive it is — and I'll tell you when to back off.",
  },
};

// Apply the edit and return the one-line confirmation.
export async function applyPrefEdit(
  athleteId: string,
  edit: Exclude<PrefEdit, { kind: "open_settings" }>,
): Promise<string> {
  const [row] = await db
    .select({ athleticHistory: athletes.athleticHistory })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  if (!row) return "Couldn't save that just now — try again in a moment.";
  const history = getAthleticHistory(row.athleticHistory);
  const prefs = getCoachPrefs(history);
  const nextPrefs = { ...prefs, [edit.kind]: edit.value };
  await db
    .update(athletes)
    .set({ athleticHistory: { ...history, coach_prefs: nextPrefs } })
    .where(eq(athletes.id, athleteId));
  return CONFIRM[edit.kind]?.[edit.value] ?? "Done.";
}
