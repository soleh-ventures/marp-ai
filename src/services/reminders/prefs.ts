// V8 (v1.1 flow redesign) — reminder preference capture & shape.
//
// Lives on athletes.reminder_prefs (jsonb). NULL = never asked.
// { enabled: false } = runner declined. { enabled: true, time_local }
// = active reminder schedule.
//
// Flow: after a plan is generated/ingested, MARP asks "Want a morning
// reminder each training day?" Runner replies with either a time
// (e.g. "6am", "5:30", "06:00") or "no thanks". Response is classified
// here so the orchestrator can persist either an enabled or disabled
// prefs object atomically.

// F7 (v1.2): when to fire the reminder relative to the session day.
//   morning_of  — the morning of the training day (default)
//   night_before — the evening before, so the runner can prep
export type ReminderTiming = "morning_of" | "night_before";

export type ReminderPrefs = {
  enabled: boolean;
  // HH:MM in 24-hour local time (athletes.timezone). Only meaningful
  // when enabled=true; absent / ignored otherwise.
  time_local?: string;
  // F7: defaults to "morning_of" when absent (back-compat with v1.1 prefs).
  timing?: ReminderTiming;
};

// Classifier output. "time_specified" carries the parsed HH:MM + timing.
export type PrefsCaptureResult =
  | { kind: "decline" }
  | { kind: "time_specified"; time_local: string; timing: ReminderTiming }
  | { kind: "ambiguous" };

const DECLINE_PATTERNS = [
  /^\s*no\b/i,
  /^\s*nope\b/i,
  /\bno\s+thanks\b/i,
  /\bno\s+reminders?\b/i,
  /\bskip\b/i,
  /\bdon'?t\b/i,
  /\bpass\b/i,
];

// Time patterns checked in order of specificity:
//  1. "H:MM AM/PM" — hour:minute with am/pm
//  2. "HH AM/PM"   — hour-only with am/pm
//  3. "HH:MM"      — bare 24-hour
// Each pattern has explicit group positions so we don't conflate
// the "minutes" group with the "am/pm" group across patterns.

// F7: phrases that mean "remind me the evening before", not the morning of.
const NIGHT_BEFORE_PATTERNS = [
  /\bnight\s*before\b/i,
  /\bnight-before\b/i,
  /\bevening\s+before\b/i,
  /\bday\s+before\b/i,
  /\bnight\s+prior\b/i,
];

// RC3 (v1.3): does this message look like the runner asking to set or change
// a reminder, OUTSIDE the post-plan capture prompt? ("remind me at 6am",
// "can you remind me the night before", "turn off reminders"). Used to route
// to the prefs capture anytime, so reminders aren't only settable once.
const REMINDER_REQUEST_PATTERNS = [
  /\bremind me\b/i,
  /\breminders?\b/i,
  /\bping me\b/i,
  /\bnudge me\b/i,
  /\bnotify me\b/i,
  /\bwake me\b/i,
];

export function looksLikeReminderRequest(body: string): boolean {
  return REMINDER_REQUEST_PATTERNS.some((re) => re.test(body));
}

// KER-73: a yes-ish reply to the reminder prompt that carries NO time
// ("yes please", "sure", "ok"). When the runner says yes-without-a-time we
// nudge for the time; anything that isn't an affirmation (and isn't a clear
// time/decline) is the runner asking a different question while the reminder
// ask is still open — that routes to the expert router instead of trapping
// them in the prompt.
const AFFIRMATION_PATTERNS = [
  /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|please|definitely|absolutely)\b/i,
  /^\s*(sounds good|go for it|do it|let'?s do it)\b/i,
];

export function looksLikeReminderAffirmation(body: string): boolean {
  return AFFIRMATION_PATTERNS.some((re) => re.test(body));
}

export function classifyPrefsReply(body: string): PrefsCaptureResult {
  if (DECLINE_PATTERNS.some((re) => re.test(body))) return { kind: "decline" };

  const timing: ReminderTiming = NIGHT_BEFORE_PATTERNS.some((re) => re.test(body))
    ? "night_before"
    : "morning_of";

  let m: RegExpMatchArray | null;

  // "6:30am" / "5:30 PM"
  m = body.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i);
  if (m) {
    return toTimeResult(
      parseInt(m[1]!, 10),
      parseInt(m[2]!, 10),
      m[3]!.toLowerCase(),
      timing,
    );
  }

  // "6am" / "6 AM" — hour only with am/pm
  m = body.match(/\b(\d{1,2})\s*(am|pm)\b/i);
  if (m) {
    return toTimeResult(parseInt(m[1]!, 10), 0, m[2]!.toLowerCase(), timing);
  }

  // "06:00" / "5:30" — bare 24-hour-ish
  m = body.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) {
    return toTimeResult(parseInt(m[1]!, 10), parseInt(m[2]!, 10), null, timing);
  }

  return { kind: "ambiguous" };
}

function toTimeResult(
  hourRaw: number,
  minute: number,
  ampm: "am" | "pm" | string | null,
  timing: ReminderTiming,
): PrefsCaptureResult {
  if (isNaN(hourRaw) || isNaN(minute)) return { kind: "ambiguous" };
  if (minute < 0 || minute > 59) return { kind: "ambiguous" };

  let hour = hourRaw;
  if (ampm === "am") {
    if (hour < 1 || hour > 12) return { kind: "ambiguous" };
    if (hour === 12) hour = 0;
  } else if (ampm === "pm") {
    if (hour < 1 || hour > 12) return { kind: "ambiguous" };
    if (hour < 12) hour += 12;
  } else {
    if (hour < 0 || hour > 23) return { kind: "ambiguous" };
  }

  const time_local =
    `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
  return { kind: "time_specified", time_local, timing };
}

// Helpers for working with the raw jsonb column. The shape can be
// tampered with at the DB level, so reads validate.
export function isPrefsAsked(raw: unknown): boolean {
  return raw !== null && raw !== undefined;
}

export function readPrefs(raw: unknown): ReminderPrefs | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.enabled !== "boolean") return null;
  const time_local =
    typeof obj.time_local === "string" && /^\d{2}:\d{2}$/.test(obj.time_local)
      ? obj.time_local
      : undefined;
  // F7: default to morning_of for back-compat with v1.1 prefs (no timing).
  const timing: ReminderTiming =
    obj.timing === "night_before" ? "night_before" : "morning_of";
  return { enabled: obj.enabled, time_local, timing };
}

// Default-disabled prefs object — written when the runner declines.
export const DECLINED_PREFS: ReminderPrefs = { enabled: false };

// Standard prompts. Kept centralised so copy stays consistent across
// surfaces and tests can lock the wording.
export const REMINDER_PROMPT =
  "\n\nLast thing — want me to remind you about each training day's session? " +
  "Tell me when: a time for the morning of (e.g. \"6am\"), or " +
  "\"night before, 9pm\" to get it the evening before. Or \"no thanks\".";

export const REMINDER_PROMPT_SIGNATURE = '"no thanks"';

// Reminder quick-picks (E3): tap values are strings classifyPrefsReply
// already parses, so a tap and a typed time land identically. Free-typed
// times ("5:45am", "night before 8pm") keep working unchanged.
export const Q_REMINDER: import("../messaging/choices.js").ChoiceQuestion = {
  id: "remind",
  choices: [
    { value: "6am", label: "⏰ Morning of — 6am" },
    { value: "7am", label: "⏰ Morning of — 7am" },
    { value: "night before, 9pm", label: "🌙 Night before — 9pm" },
    { value: "no thanks", label: "No reminders" },
  ],
};

export const REMINDER_CAPTURED_REPLY = (
  time: string,
  timing: ReminderTiming = "morning_of",
): string => {
  const when =
    timing === "night_before"
      ? `at ${time} the night before each training day`
      : `at ${time} on training-day mornings`;
  return (
    `Locked in. I'll ping you ${when}. ` +
    "You can change this anytime — just text me a new time or 'no reminders'."
  );
};

export const REMINDER_DECLINED_REPLY =
  "All good — no reminders. You can flip this on anytime by texting me " +
  "a time (e.g. '6am'). Now, ready to talk about training?";

export const REMINDER_AMBIGUOUS_REPLY =
  "Sorry — I need either a time (e.g. \"6am\" or \"5:30\") or \"no thanks\".";

// KER-73: appended to the expert router's answer when the runner asked a
// different question while the reminder ask was still open. Keeps the ask
// live for later (and must contain REMINDER_PROMPT_SIGNATURE so the
// reply-context branch in process-incoming stays armed next turn).
export const REMINDER_REASK =
  "\n\n(Still open whenever you want it: a reminder for each training day — " +
  "just send a time like \"6am\", or \"no thanks\".)";
