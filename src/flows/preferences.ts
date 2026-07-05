// Preference onboarding — the deterministic tap phase between LLM intake
// extraction and the plan pivot (eng amendment 7: this is process-incoming
// state like pivot_state, NOT LLM-driven onboarding sections — no LLM call
// per tap, no turn_count interaction).
//
// Flow (plan Appendix A):
//   mirror card → coaching style → reply length → training push
//   (→ aggressive confirm) → holistic → reflection → pivot
//
// The persona activates THE MESSAGE AFTER the coaching-style answer and never
// switches off. Defaults are never silent — "You decide, coach" and ignored
// re-asks both get a spoken default line.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { athletes } from "../db/schema.js";
import { config } from "../config.js";
import { getOnboardingPrompt } from "../router/prompts.js";
import { llmCall } from "../services/llm-call.js";
import { logFunnel } from "../services/funnel.js";
import type { ChoiceQuestion } from "../services/messaging/choices.js";
import { matchFreeText } from "../services/messaging/choices.js";
import {
  getAthleticHistory,
  parseOnboardingResponse,
  type AthleticHistory,
} from "./onboarding.js";

// ── Types & state ─────────────────────────────────────────────────────

export type CoachingStyle = "director" | "partner" | "companion";
export type ReplyStyle = "short" | "balanced" | "long";
export type TrainingStyle = "easy" | "balanced" | "hard" | "aggressive";

export type CoachPrefs = {
  coaching_style?: CoachingStyle;
  reply_style?: ReplyStyle;
  training_style?: TrainingStyle;
  // Which fields the athlete delegated ("You decide, coach") or defaulted —
  // the coach may proactively revisit these later.
  delegated?: string[];
};

export type PrefsState =
  | "mirror"
  | "mirror_fix"
  | "coach"
  | "reply"
  | "training"
  | "training_confirm"
  | "holistic"
  | "done";

type PrefsMeta = {
  // Re-asks used for the CURRENT question (interruption policy: answer the
  // interruption, re-ask once, then default and move on).
  reasks: number;
  // Mirror-card correction loops used (bounded at 2).
  fix_loops: number;
};

export function getPrefsState(history: AthleticHistory): PrefsState | undefined {
  const s = history.prefs_state;
  if (
    s === "mirror" || s === "mirror_fix" || s === "coach" || s === "reply" ||
    s === "training" || s === "training_confirm" || s === "holistic" || s === "done"
  ) {
    return s;
  }
  return undefined;
}

export function getCoachPrefs(history: AthleticHistory): CoachPrefs {
  const p = history.coach_prefs;
  if (p && typeof p === "object" && !Array.isArray(p)) return p as CoachPrefs;
  return {};
}

function prefsMeta(history: AthleticHistory): PrefsMeta {
  const m = history.prefs_meta as PrefsMeta | undefined;
  return {
    reasks: typeof m?.reasks === "number" ? m.reasks : 0,
    fix_loops: typeof m?.fix_loops === "number" ? m.fix_loops : 0,
  };
}

// ── Questions (single source of truth for buttons + matching) ─────────

export const Q_MIRROR: ChoiceQuestion = {
  id: "mirror",
  choices: [
    { value: "confirm", label: "✓ All correct", synonyms: ["correct", "yes", "yep", "all good", "looks good"] },
    { value: "fix", label: "✏️ Fix something", synonyms: ["wrong", "change", "edit", "no"] },
  ],
};

export const Q_COACH: ChoiceQuestion = {
  id: "coach",
  choices: [
    { value: "director", label: "🎯 Director", synonyms: ["hard"] },
    { value: "partner", label: "⚖️ Partner", synonyms: ["balanced"] },
    { value: "companion", label: "🤝 Companion", synonyms: ["easy", "friend", "gentle"] },
    { value: "delegate", label: "You decide, coach", synonyms: ["you decide", "you choose", "up to you"] },
  ],
};

export const Q_REPLY: ChoiceQuestion = {
  id: "reply",
  choices: [
    { value: "short", label: "Short", synonyms: ["brief", "concise"] },
    { value: "balanced", label: "Balanced", synonyms: ["medium", "normal"] },
    { value: "long", label: "Long", synonyms: ["detailed", "full"] },
    { value: "delegate", label: "You decide, coach", synonyms: ["you decide", "you choose", "up to you"] },
  ],
};

export const Q_TRAINING: ChoiceQuestion = {
  id: "training",
  choices: [
    { value: "easy", label: "🌱 Easy", synonyms: ["conservative", "gentle"] },
    { value: "balanced", label: "⚖️ Balanced", synonyms: ["classic", "normal"] },
    { value: "hard", label: "🔺 Hard", synonyms: ["ambitious", "tough"] },
    { value: "aggressive", label: "🔥 Aggressive", synonyms: ["all in", "max"] },
    { value: "delegate", label: "You decide, coach", synonyms: ["you decide", "you choose", "up to you"] },
  ],
};

export const Q_TRAINING_CONFIRM: ChoiceQuestion = {
  id: "trainconf",
  choices: [
    { value: "aggressive_yes", label: "Yes — all in", synonyms: ["yes", "all in", "confirm"] },
    { value: "go_hard", label: "Go Hard instead", synonyms: ["hard", "no", "back off"] },
  ],
};

export const Q_HOLISTIC: ChoiceQuestion = {
  id: "holistic",
  choices: [{ value: "skip", label: "Skip →", synonyms: ["skip", "no", "nothing", "nope"] }],
};

// Migration beat for existing athletes (answer-first: this rides AFTER their
// actual question was answered — eng amendment 15).
export const Q_CALIB: ChoiceQuestion = {
  id: "calib",
  choices: [
    { value: "set_style", label: "Set my style", synonyms: ["set style", "yes", "sure"] },
    { value: "later", label: "Later", synonyms: ["not now", "no", "skip"] },
  ],
};

export const MSG_CALIB_OFFER =
  "\n\nAlso — 3 quick taps and I coach exactly the way you like " +
  "(how I talk, how much I say, how hard the plan pushes).";

// ── Copy (the copy IS the product — Appendix A verbatim) ──────────────

const STYLE_LABEL: Record<CoachingStyle, string> = {
  director: "Director",
  partner: "Partner",
  companion: "Companion",
};

// The persona flips ON in the very first line after the style tap.
const PERSONA_OPENER: Record<CoachingStyle, string> = {
  director: "Good. I call it, you run it.",
  partner: "Good — we decide together, and I'll be straight with you.",
  companion: "Got you. I'm at your side the whole way.",
};

export const MSG_COACH_QUESTION =
  "How should I coach you?\n" +
  "🎯 Director — I make the calls, flag the risks, push you\n" +
  "⚖️ Partner — we decide together; direct but encouraging\n" +
  "🤝 Companion — a friend at your side; supportive, patient";

// Demonstrative: each descriptor line is WRITTEN at its own length.
const MSG_REPLY_QUESTION_TAIL =
  "Next — how much do I say by default?\n" +
  "Short — like this.\n" +
  "Balanced — a solid paragraph when the moment calls for it, with enough of the why to trust the call.\n" +
  "Long — the full reasoning behind every session: what it builds, why it lands on this day, how it fits the bigger arc of your training, and what to watch for while you run it.\n" +
  "(A default, not a cap — ask for more or less anytime and I follow the ask.)";

const MSG_TRAINING_QUESTION =
  "Last tap — how hard should the plan push?\n" +
  "🌱 Easy — conservative build, extra recovery\n" +
  "⚖️ Balanced — classic progression\n" +
  "🔺 Hard — ambitious load, fewer down-weeks\n" +
  "🔥 Aggressive — maximum safe stimulus";

const MSG_AGGRESSIVE_CONFIRM =
  "Aggressive means fewer down-weeks and load that bites. Injuries end " +
  "seasons — I'll push, and I'll also tell you when to back off. Still in?";

export const MSG_HOLISTIC_QUESTION =
  "One more — I coach the whole athlete, not just the runs. Anything else I " +
  "should know? Other sports you do, what your work/family load looks like, " +
  "how you sleep — and anything you want help with beyond running (fueling, " +
  "sleep, strength, headspace).\n" +
  "Totally optional — I only use this to shape your training, and you can " +
  "ask me to forget it anytime.";

function spokenDefault(field: "coach" | "reply" | "training"): string {
  if (field === "coach") {
    return "I'll start as your Partner — say \"be harder on me\" or \"gentler\" anytime and I switch.";
  }
  if (field === "reply") {
    return "I'll keep replies balanced — say \"shorter\" or \"more detail\" anytime.";
  }
  return "I'll build the plan balanced — say \"push harder\" or \"ease off\" anytime.";
}

// ── Mirror card ───────────────────────────────────────────────────────

// Deterministic profile mirror — the athlete sees they were heard. Only
// lines with data render.
export function renderMirrorCard(history: AthleticHistory): string {
  const lines: string[] = ["Here's what I've got:"];
  const race = history.target_race as
    | { name?: string; date?: string; goal_time?: string; distance?: string }
    | undefined;
  if (race && (race.name || race.distance)) {
    const bits = [race.name ?? race.distance, race.date, race.goal_time ? `target ${race.goal_time}` : null]
      .filter(Boolean)
      .join(" · ");
    lines.push(`🎯 ${bits}`);
  } else if (history.goal_type === "get fitter" || !race) {
    lines.push("🎯 Goal: get fitter (no race on the calendar yet)");
  }
  const weekly = history.current_mileage_km_per_week;
  const longest = history.longest_recent_run_km;
  if (weekly || longest) {
    const bits = [
      weekly ? `~${weekly} km/week` : null,
      longest ? `longest ${longest} km` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`🏃 ${bits}`);
  }
  const days = history.training_days_per_week;
  const time = history.preferred_time;
  if (days || time) {
    const bits = [days ? `${days} days/week` : null, time ? String(time) : null]
      .filter(Boolean)
      .join(" · ");
    lines.push(`📅 ${bits}`);
  }
  const injuries = history.current_injuries;
  if (Array.isArray(injuries) && injuries.length > 0) {
    lines.push(`🩹 ${injuries.map((i) => (typeof i === "string" ? i : JSON.stringify(i))).join(", ")}`);
  }
  if (typeof history.city === "string" && history.city) {
    lines.push(`📍 ${history.city}`);
  }
  lines.push("");
  lines.push("Anything wrong?");
  return lines.join("\n");
}

// ── Persistence helper ────────────────────────────────────────────────

async function saveHistory(athleteId: string, history: AthleticHistory): Promise<void> {
  await db
    .update(athletes)
    .set({ athleticHistory: history })
    .where(eq(athletes.id, athleteId));
}

function withPrefs(
  history: AthleticHistory,
  state: PrefsState,
  patch?: Partial<CoachPrefs>,
  meta?: Partial<PrefsMeta>,
): AthleticHistory {
  const prefs = { ...getCoachPrefs(history), ...(patch ?? {}) };
  const m = { ...prefsMeta(history), ...(meta ?? {}) };
  return { ...history, prefs_state: state, coach_prefs: prefs, prefs_meta: m };
}

// ── Correction extraction (mirror fix + corrections in ANY section) ───

// Reuses the onboarding extractor prompt to pull corrected fields out of free
// text ("actually I'm 42 not 24", "my race is Oct 12"). Merges into history
// WITHOUT touching onboarding meta. Returns null when nothing was extracted.
export async function extractCorrection(input: {
  athleteId: string;
  messageId: string | null;
  body: string;
  history: AthleticHistory;
}): Promise<AthleticHistory | null> {
  try {
    const res = await llmCall(
      {
        model: config.llm.domainModel,
        system: getOnboardingPrompt(),
        user:
          "# Context\nThe runner is correcting or adding profile details after " +
          "the intake. Extract ONLY what this message states. Reply JSON as " +
          'usual; set next_section to "complete"; keep reply to one short ' +
          "confirmation line.\n\n# Runner's message\n" +
          input.body,
        maxTokens: 400,
        temperature: 0.2,
        cacheSystem: true,
      },
      {
        athleteId: input.athleteId,
        messageId: input.messageId ?? undefined,
        component: "other",
      },
    );
    const parsed = parseOnboardingResponse(res.text);
    if (Object.keys(parsed.extracted).length === 0) return null;
    const merged: AthleticHistory = { ...input.history };
    for (const [k, v] of Object.entries(parsed.extracted)) {
      const existing = merged[k];
      if (Array.isArray(existing) && Array.isArray(v)) merged[k] = [...existing, ...v];
      else if (
        existing && typeof existing === "object" &&
        v && typeof v === "object" && !Array.isArray(v)
      ) {
        merged[k] = { ...(existing as object), ...(v as object) };
      } else merged[k] = v;
    }
    return merged;
  } catch (err) {
    console.error("extractCorrection failed:", (err as Error).message);
    return null;
  }
}

// ── Holistic extraction (PR 2) ────────────────────────────────────────

type HolisticExtract = {
  other_sports?: Array<{ sport: string; frequency_per_week?: number; note?: string }>;
  life_context?: { work?: string; stress?: string; family?: string; sleep?: string; note?: string };
  coach_topics?: string[];
};

const HOLISTIC_SYSTEM =
  "You extract structured life-context from a runner's free-text answer to: " +
  '"anything else I should know — other sports, work/family load, sleep, ' +
  'topics you want coaching on beyond running?" Reply with ONLY a JSON ' +
  "object, no prose, with any of these keys (omit what wasn't mentioned):\n" +
  '  other_sports: [{"sport": string, "frequency_per_week"?: number, "note"?: string}]\n' +
  '  life_context: {"work"?: string, "stress"?: string, "family"?: string, "sleep"?: string, "note"?: string}\n' +
  '  coach_topics: string[]  // from: nutrition, sleep, strength, mental, race_strategy, mobility\n' +
  "Keep values short (a few words). Never invent what wasn't said. If the " +
  "message contains nothing relevant, reply {}.";

export async function extractHolistic(input: {
  athleteId: string;
  messageId: string | null;
  body: string;
}): Promise<HolisticExtract> {
  try {
    const res = await llmCall(
      {
        model: config.llm.binderModel,
        system: HOLISTIC_SYSTEM,
        user: input.body,
        maxTokens: 400,
        temperature: 0.2,
        cacheSystem: true,
      },
      {
        athleteId: input.athleteId,
        messageId: input.messageId ?? undefined,
        component: "other",
      },
    );
    const match = res.text.match(/\{[\s\S]*\}/);
    if (!match) return {};
    const parsed = JSON.parse(match[0]) as HolisticExtract;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    // Extraction failures NEVER block onboarding (failure-modes registry).
    console.error("extractHolistic failed:", (err as Error).message);
    return {};
  }
}

// Persona-voiced reflection of the disclosure — the trust beat. Deterministic
// template over the extracted fields (reliable > fancy).
export function renderHolisticReflection(ex: HolisticExtract): string {
  const bits: string[] = [];
  if (ex.other_sports && ex.other_sports.length > 0) {
    const names = ex.other_sports.map((s) => s.sport).filter(Boolean).join(", ");
    if (names) bits.push(`${names} stays in the picture — I plan around it, not against it.`);
  }
  const lc = ex.life_context ?? {};
  const load = [lc.work, lc.family, lc.stress].filter(Boolean).join(", ");
  const sleep = lc.sleep;
  if (load && sleep) {
    bits.push(`With ${load} and ${sleep} sleep, recovery is the real constraint — I won't pretend otherwise.`);
  } else if (load) {
    bits.push(`I'll budget the training load around ${load}.`);
  } else if (sleep) {
    bits.push(`Sleep (${sleep}) shapes how hard we can push — noted.`);
  }
  if (ex.coach_topics && ex.coach_topics.length > 0) {
    bits.push(`And I'm on ${ex.coach_topics.join(", ")} too, not just the running.`);
  }
  if (bits.length === 0) return "Noted.";
  return `Noted. ${bits.join(" ")}`;
}

// ── The flow driver ───────────────────────────────────────────────────

export type PrefsTurnResult =
  // The flow consumed the message and produced the next beat.
  | { kind: "handled"; reply: string; choices?: ChoiceQuestion; pivotReady?: boolean }
  // The message wasn't an answer — caller answers it via the expert, then
  // calls buildReask() and appends its text/choices.
  | { kind: "interrupt" };

function questionFor(state: PrefsState): { text: string; q: ChoiceQuestion } | null {
  switch (state) {
    case "mirror":
      return { text: "", q: Q_MIRROR }; // mirror text is rendered separately
    case "coach":
      return { text: MSG_COACH_QUESTION, q: Q_COACH };
    case "reply":
      return { text: MSG_REPLY_QUESTION_TAIL, q: Q_REPLY };
    case "training":
      return { text: MSG_TRAINING_QUESTION, q: Q_TRAINING };
    case "training_confirm":
      return { text: MSG_AGGRESSIVE_CONFIRM, q: Q_TRAINING_CONFIRM };
    case "holistic":
      return { text: MSG_HOLISTIC_QUESTION, q: Q_HOLISTIC };
    default:
      return null;
  }
}

// Start the prefs phase: called by process-incoming when the LLM intake
// finishes. Returns the mirror-card beat; persists prefs_state.
export async function startPrefsFlow(
  athleteId: string,
  history: AthleticHistory,
): Promise<{ reply: string; choices: ChoiceQuestion }> {
  const next = withPrefs(history, "mirror");
  await saveHistory(athleteId, next);
  return { reply: renderMirrorCard(next), choices: Q_MIRROR };
}

// Re-ask the current question once; on the second miss, apply the default,
// say so, and advance. Returns the text to APPEND after the interruption
// answer, plus choices.
export async function buildReask(
  athleteId: string,
  historyIn: AthleticHistory,
): Promise<{ append: string; choices?: ChoiceQuestion }> {
  // Fresh read — the expert route may have taken time.
  const [row] = await db
    .select({ athleticHistory: athletes.athleticHistory })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  const history = row ? getAthleticHistory(row.athleticHistory) : historyIn;
  const state = getPrefsState(history);
  if (!state || state === "done") return { append: "" };
  const meta = prefsMeta(history);
  const q = questionFor(state);
  if (!q) return { append: "" };

  if (meta.reasks < 1) {
    await saveHistory(athleteId, withPrefs(history, state, undefined, { reasks: meta.reasks + 1 }));
    const text = state === "mirror" ? renderMirrorCard(history) : q.text;
    return { append: `\n\n${text}`, choices: q.q };
  }

  // Second miss → default this question (spoken) and advance.
  const advanced = await applyDefaultAndAdvance(athleteId, history, state);
  return advanced;
}

async function applyDefaultAndAdvance(
  athleteId: string,
  history: AthleticHistory,
  state: PrefsState,
): Promise<{ append: string; choices?: ChoiceQuestion }> {
  if (state === "mirror" || state === "mirror_fix") {
    const next = withPrefs(history, "coach", undefined, { reasks: 0 });
    await saveHistory(athleteId, next);
    return { append: `\n\n${MSG_COACH_QUESTION}`, choices: Q_COACH };
  }
  if (state === "coach") {
    const next = withPrefs(
      history,
      "reply",
      { coaching_style: "partner", delegated: [...(getCoachPrefs(history).delegated ?? []), "coaching_style"] },
      { reasks: 0 },
    );
    await saveHistory(athleteId, next);
    return {
      append: `\n\n${spokenDefault("coach")}\n\n${MSG_REPLY_QUESTION_TAIL}`,
      choices: Q_REPLY,
    };
  }
  if (state === "reply") {
    const next = withPrefs(
      history,
      "training",
      { reply_style: "balanced", delegated: [...(getCoachPrefs(history).delegated ?? []), "reply_style"] },
      { reasks: 0 },
    );
    await saveHistory(athleteId, next);
    return { append: `\n\n${spokenDefault("reply")}\n\n${MSG_TRAINING_QUESTION}`, choices: Q_TRAINING };
  }
  if (state === "training" || state === "training_confirm") {
    const next = withPrefs(
      history,
      "holistic",
      { training_style: "balanced", delegated: [...(getCoachPrefs(history).delegated ?? []), "training_style"] },
      { reasks: 0 },
    );
    await saveHistory(athleteId, next);
    logFunnel("prefs_answered", athleteId);
    return { append: `\n\n${spokenDefault("training")}\n\n${MSG_HOLISTIC_QUESTION}`, choices: Q_HOLISTIC };
  }
  // holistic: default = skip
  const next = withPrefs(history, "done", undefined, { reasks: 0 });
  await saveHistory(athleteId, next);
  logFunnel("holistic_answered", athleteId);
  return { append: "" };
}

// The main turn handler. Caller guarantees prefs_state is active (not done).
export async function handlePrefsTurn(input: {
  athleteId: string;
  messageId: string;
  body: string;
  history: AthleticHistory;
}): Promise<PrefsTurnResult> {
  const { athleteId, messageId, body, history } = input;
  const state = getPrefsState(history);
  const prefs = getCoachPrefs(history);
  const meta = prefsMeta(history);

  switch (state) {
    case "mirror": {
      const m = matchFreeText(Q_MIRROR, body);
      if (m === "confirm") {
        const next = withPrefs(history, "coach", undefined, { reasks: 0 });
        await saveHistory(athleteId, next);
        return { kind: "handled", reply: MSG_COACH_QUESTION, choices: Q_COACH };
      }
      if (m === "fix") {
        const next = withPrefs(history, "mirror_fix");
        await saveHistory(athleteId, next);
        return {
          kind: "handled",
          reply: "Tell me what to fix — just type it (\"I'm 42, not 24\", \"race is Oct 12\").",
        };
      }
      // A correction typed directly at the mirror ("actually I'm 42") — treat
      // any longer text as a fix attempt, not an interruption.
      if (body.trim().length > 25) {
        return handleMirrorFix(athleteId, messageId, body, history, meta);
      }
      return { kind: "interrupt" };
    }

    case "mirror_fix":
      return handleMirrorFix(athleteId, messageId, body, history, meta);

    case "coach": {
      const m = matchFreeText(Q_COACH, body);
      if (!m) return { kind: "interrupt" };
      const style: CoachingStyle = m === "delegate" ? "partner" : (m as CoachingStyle);
      const delegated =
        m === "delegate" ? [...(prefs.delegated ?? []), "coaching_style"] : prefs.delegated;
      const next = withPrefs(
        history,
        "reply",
        { coaching_style: style, ...(delegated ? { delegated } : {}) },
        { reasks: 0 },
      );
      await saveHistory(athleteId, next);
      // Persona flips ON right here — the payoff moment.
      const opener = m === "delegate" ? spokenDefault("coach") : PERSONA_OPENER[style];
      return {
        kind: "handled",
        reply: `${opener}\n\n${MSG_REPLY_QUESTION_TAIL}`,
        choices: Q_REPLY,
      };
    }

    case "reply": {
      const m = matchFreeText(Q_REPLY, body);
      if (!m) return { kind: "interrupt" };
      const val: ReplyStyle = m === "delegate" ? "balanced" : (m as ReplyStyle);
      const delegated =
        m === "delegate" ? [...(prefs.delegated ?? []), "reply_style"] : prefs.delegated;
      const next = withPrefs(
        history,
        "training",
        { reply_style: val, ...(delegated ? { delegated } : {}) },
        { reasks: 0 },
      );
      await saveHistory(athleteId, next);
      const ack = m === "delegate" ? `${spokenDefault("reply")}\n\n` : "";
      return { kind: "handled", reply: `${ack}${MSG_TRAINING_QUESTION}`, choices: Q_TRAINING };
    }

    case "training": {
      const m = matchFreeText(Q_TRAINING, body);
      if (!m) return { kind: "interrupt" };
      if (m === "aggressive") {
        const next = withPrefs(history, "training_confirm", undefined, { reasks: 0 });
        await saveHistory(athleteId, next);
        return { kind: "handled", reply: MSG_AGGRESSIVE_CONFIRM, choices: Q_TRAINING_CONFIRM };
      }
      const val: TrainingStyle = m === "delegate" ? "balanced" : (m as TrainingStyle);
      const delegated =
        m === "delegate" ? [...(prefs.delegated ?? []), "training_style"] : prefs.delegated;
      const next = withPrefs(
        history,
        "holistic",
        { training_style: val, ...(delegated ? { delegated } : {}) },
        { reasks: 0 },
      );
      await saveHistory(athleteId, next);
      logFunnel("prefs_answered", athleteId);
      const ack = m === "delegate" ? `${spokenDefault("training")}\n\n` : "";
      return { kind: "handled", reply: `${ack}${MSG_HOLISTIC_QUESTION}`, choices: Q_HOLISTIC };
    }

    case "training_confirm": {
      const m = matchFreeText(Q_TRAINING_CONFIRM, body);
      if (!m) return { kind: "interrupt" };
      const val: TrainingStyle = m === "aggressive_yes" ? "aggressive" : "hard";
      const next = withPrefs(history, "holistic", { training_style: val }, { reasks: 0 });
      await saveHistory(athleteId, next);
      logFunnel("prefs_answered", athleteId);
      const ack =
        m === "aggressive_yes"
          ? "All in it is. I'll bring the load — and the brakes when they matter.\n\n"
          : "Hard it is — ambitious, with down-weeks kept.\n\n";
      return { kind: "handled", reply: `${ack}${MSG_HOLISTIC_QUESTION}`, choices: Q_HOLISTIC };
    }

    case "holistic": {
      const skipped = matchFreeText(Q_HOLISTIC, body) === "skip";
      let reflection = "";
      let next = withPrefs(history, "done", undefined, { reasks: 0 });
      if (!skipped) {
        const extracted = await extractHolistic({ athleteId, messageId, body });
        const merged: AthleticHistory = { ...next };
        if (extracted.other_sports) {
          const existing = Array.isArray(merged.other_sports) ? merged.other_sports : [];
          merged.other_sports = [...existing, ...extracted.other_sports];
        }
        if (extracted.life_context) {
          merged.life_context = {
            ...(merged.life_context as object | undefined),
            ...extracted.life_context,
          };
        }
        if (extracted.coach_topics) {
          const existing = Array.isArray(merged.coach_topics) ? merged.coach_topics : [];
          merged.coach_topics = [...new Set([...existing, ...extracted.coach_topics])];
        }
        next = merged;
        reflection = `${renderHolisticReflection(extracted)}\n\n`;
      }
      await saveHistory(athleteId, next);
      logFunnel("holistic_answered", athleteId);
      // pivotReady: process-incoming appends the pivot question (it owns
      // pivot_state + the funnel line for the choice).
      return { kind: "handled", reply: reflection.trimEnd(), pivotReady: true };
    }

    default:
      return { kind: "interrupt" };
  }
}

async function handleMirrorFix(
  athleteId: string,
  messageId: string,
  body: string,
  history: AthleticHistory,
  meta: PrefsMeta,
): Promise<PrefsTurnResult> {
  if (meta.fix_loops >= 2) {
    const next = withPrefs(history, "coach", undefined, { reasks: 0 });
    await saveHistory(athleteId, next);
    return {
      kind: "handled",
      reply: `I'll fix details as we go — just tell me anytime.\n\n${MSG_COACH_QUESTION}`,
      choices: Q_COACH,
    };
  }
  const corrected = await extractCorrection({ athleteId, messageId, body, history });
  const base = corrected ?? history;
  const next = withPrefs(base, "mirror", undefined, {
    fix_loops: meta.fix_loops + 1,
    reasks: 0,
  });
  await saveHistory(athleteId, next);
  const lead = corrected ? "Fixed. " : "Hmm, I couldn't pull a correction out of that. ";
  return {
    kind: "handled",
    reply: `${lead}${renderMirrorCard(next)}`,
    choices: Q_MIRROR,
  };
}

export { STYLE_LABEL, PERSONA_OPENER };
