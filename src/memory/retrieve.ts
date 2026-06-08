import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  activeFlags,
  activities,
  athletes,
  messages,
  raceBlocks,
  stravaConnections,
} from "../db/schema.js";
import { getAthleticHistory } from "../flows/onboarding.js";
import { getStoredPlan } from "../services/plan/storage.js";
import { renderPlanForContext, type Plan } from "../services/plan/types.js";
import {
  computeWeekAdherence,
  currentWeekIndex,
  renderAdherenceLine,
} from "../services/plan/adherence.js";
import {
  loadStreamSummaries,
  renderStreamAnnotation,
} from "../services/strava-streams.js";
import { nowInZone, type ZonedNow } from "../services/reminders/timezone.js";

// How many recent inbound + outbound messages to surface to the LLM as
// dialog context. 20 is roughly the last week of chat at typical cadence
// — small enough not to balloon prompt cost, long enough to catch
// "wait, you told me yesterday…" callbacks.
const RECENT_MESSAGE_LIMIT = 20;

// How many recent activities (any source — Strava, FIT, GPX) to surface.
// 14 covers roughly the last 1–2 weeks of consistent training; runners
// who train less frequently get a longer time window naturally.
const RECENT_ACTIVITY_LIMIT = 14;

// T8: how many past completed-block summaries to surface. 3 covers a
// typical year of training (one peak race per half-year, plus a tune-up)
// without ballooning the prompt — each summary is ~200-300 words.
const PAST_BLOCK_SUMMARY_LIMIT = 3;

// Whether Strava is currently wired up for this athlete. Surfaced so the
// LLM can ground its replies — without this, an athlete who's connected
// but has no synced activities yet gets told "Strava isn't connected"
// (the LLM was guessing from the absence of activities).
export type StravaStatus = "connected" | "revoked" | "not_connected";

export type MemoryContext = {
  // The formatted string the router feeds to the domain LLMs.
  text: string;
  // Counts surfaced for tests + observability — no need for raw rows
  // outside this module.
  athleteName: string | null;
  activeFlagCount: number;
  recentMessageCount: number;
  recentActivityCount: number;
  // T8: how many past-block narrative summaries are surfaced in `text`.
  pastBlockSummaryCount: number;
  stravaStatus: StravaStatus;
};

/**
 * Build a single context string for the LLM by pulling the runner's
 * profile, currently-active flags (unresolved injuries, illness,
 * travel, life events), the active race block (if any), and the last
 * N messages.
 *
 * Returns an empty-context object (text: "") when the athleteId can't
 * be found — the router should still answer, just without personalisation.
 */
export async function getMemoryContext(
  athleteId: string,
): Promise<MemoryContext> {
  const athleteRows = await db
    .select({
      id: athletes.id,
      name: athletes.name,
      locale: athletes.locale,
      phone: athletes.phone,
      timezone: athletes.timezone,
      homeCity: athletes.homeCity,
      athleticHistory: athletes.athleticHistory,
    })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  const athlete = athleteRows[0];
  if (!athlete) {
    return {
      text: "",
      athleteName: null,
      activeFlagCount: 0,
      recentMessageCount: 0,
      recentActivityCount: 0,
      pastBlockSummaryCount: 0,
      stravaStatus: "not_connected",
    };
  }

  // Active = no resolved_at. Most recent first; older issues fade out.
  const flagRows = await db
    .select()
    .from(activeFlags)
    .where(
      and(eq(activeFlags.athleteId, athleteId), isNull(activeFlags.resolvedAt)),
    )
    .orderBy(desc(activeFlags.startedAt))
    .limit(10);

  // Active race block (state = 'active'). Most runners have one at a time;
  // if multiple exist for some reason, take the most recently created.
  const blockRows = await db
    .select()
    .from(raceBlocks)
    .where(
      and(eq(raceBlocks.athleteId, athleteId), eq(raceBlocks.state, "active")),
    )
    .orderBy(desc(raceBlocks.createdAt))
    .limit(1);
  const block = blockRows[0];

  // T8: past completed blocks with a narrative summary. This is MARP's
  // long-term memory — it survives across blocks so the next-cycle
  // self can say "your IT band acted up in the last 3 weeks of build
  // last time". Cap at 3 most-recent — older context fades naturally.
  const pastSummaryRows = await db
    .select({
      raceName: raceBlocks.raceName,
      raceDate: raceBlocks.raceDate,
      raceDistance: raceBlocks.raceDistance,
      summary: raceBlocks.summary,
    })
    .from(raceBlocks)
    .where(
      and(
        eq(raceBlocks.athleteId, athleteId),
        eq(raceBlocks.state, "completed"),
      ),
    )
    .orderBy(desc(raceBlocks.raceDate))
    .limit(PAST_BLOCK_SUMMARY_LIMIT);
  const pastBlocks = pastSummaryRows.filter(
    (r): r is typeof r & { summary: string } => r.summary !== null,
  );

  // Last N messages, then reverse so the LLM sees oldest→newest in the
  // prompt — that ordering reads more naturally than "here are the last
  // 20, most recent first".
  const recent = await db
    .select({
      direction: messages.direction,
      body: messages.body,
      receivedAt: messages.receivedAt,
    })
    .from(messages)
    .where(eq(messages.athleteId, athleteId))
    .orderBy(desc(messages.receivedAt))
    .limit(RECENT_MESSAGE_LIMIT);
  const recentChrono = [...recent].reverse();

  // Strava connection status — surfaced so the LLM has a definitive
  // signal. The webhook only fires for new/edited activities, so a
  // freshly-connected athlete legitimately has zero recent runs; without
  // this line, the LLM guesses "Strava isn't connected" and confuses the
  // runner.
  const stravaRows = await db
    .select({ revokedAt: stravaConnections.revokedAt })
    .from(stravaConnections)
    .where(eq(stravaConnections.athleteId, athleteId))
    .limit(1);
  const stravaStatus: StravaStatus = !stravaRows[0]
    ? "not_connected"
    : stravaRows[0].revokedAt
      ? "revoked"
      : "connected";

  // Recent activities. Newest first — the LLM wants to know what the
  // runner *just* did to ground "how did that go" / "what's next" replies.
  const activityRowsRaw = await db
    .select({
      id: activities.id,
      discipline: activities.discipline,
      startedAt: activities.startedAt,
      durationS: activities.durationS,
      metrics: activities.metrics,
      longRun: activities.longRun,
    })
    .from(activities)
    .where(eq(activities.athleteId, athleteId))
    .orderBy(desc(activities.startedAt))
    .limit(RECENT_ACTIVITY_LIMIT);

  // KER-80 (Phase 3): attach the Strava streams annotation (split pattern,
  // HR drift, km range) to each activity that has one, so the coaching LLM
  // can cite the real shape of the run, not just the average.
  const streamMap = await loadStreamSummaries(activityRowsRaw.map((r) => r.id));
  const activityRows: ActivityRow[] = activityRowsRaw.map((r) => {
    const s = streamMap.get(r.id);
    const note = s ? renderStreamAnnotation(s) : "";
    return { ...r, streamNote: note || null };
  });

  // F8 follow-up: anchor every conversational reply to the runner's real
  // local date + weekday. Without this the coaching LLMs (domain + synth)
  // had no idea what day it was and guessed — getting "your run today" and
  // weekday math wrong. Resolve from stored tz, falling back to phone code.
  const zonedToday = nowInZone(athlete.timezone, athlete.phone);

  // Pull the stored plan out so we can render it with real calendar dates
  // instead of dumping raw JSON the LLM has to do date math against.
  const plan = getStoredPlan(getAthleticHistory(athlete.athleticHistory));

  return {
    text: formatContext({
      name: athlete.name,
      locale: athlete.locale,
      homeCity: athlete.homeCity,
      athleticHistory: athlete.athleticHistory,
      flags: flagRows,
      block,
      pastBlocks,
      messages: recentChrono,
      activities: activityRows,
      stravaStatus,
      zonedToday,
      plan,
    }),
    athleteName: athlete.name,
    activeFlagCount: flagRows.length,
    recentMessageCount: recentChrono.length,
    recentActivityCount: activityRows.length,
    pastBlockSummaryCount: pastBlocks.length,
    stravaStatus,
  };
}

export type ActivityRow = {
  discipline: string;
  startedAt: Date;
  durationS: number;
  metrics: unknown;
  longRun: boolean;
  // KER-80: pre-rendered streams annotation (split pattern / HR drift / km
  // range), or null when no streams summary exists for this activity.
  streamNote?: string | null;
};

type FormatInput = {
  name: string | null;
  locale: string;
  // KER-78: the runner's HOME city (location SSOT). Surfaced as part of the
  // ground-truth line so the LLM has an authoritative city to anchor on and
  // stops grabbing a stale one from the message log.
  homeCity?: string | null;
  athleticHistory: unknown;
  flags: Array<{
    kind: string;
    body: string;
    startedAt: Date;
  }>;
  block:
    | {
        raceName: string;
        raceDate: Date;
        raceDistance: string;
        goalFinishTime: string | null;
      }
    | undefined;
  // T8: past completed-block narrative summaries, newest race_date first.
  pastBlocks?: Array<{
    raceName: string;
    raceDate: Date;
    raceDistance: string;
    summary: string;
  }>;
  messages: Array<{
    direction: "in" | "out";
    body: string;
    receivedAt: Date;
  }>;
  activities?: Array<ActivityRow>;
  stravaStatus?: StravaStatus;
  // The runner's local "today" — date + weekday + timezone. Surfaced as
  // the first line so the LLM never derives the weekday itself.
  zonedToday?: ZonedNow;
  // The stored training plan, rendered with real dates rather than dumped
  // as raw JSON inside athleticHistory.
  plan?: Plan | null;
};

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${m.toString().padStart(2, "0")}`;
}

function formatPace(secondsPerKm: number): string {
  const m = Math.floor(secondsPerKm / 60);
  const s = Math.round(secondsPerKm - m * 60);
  return `${m}:${s.toString().padStart(2, "0")}/km`;
}

// One line per activity. Optional fields (distance, pace, HR) drop out
// quietly when absent — strength sessions don't have a pace, etc.
export function formatActivityLine(a: ActivityRow): string {
  const date = a.startedAt.toISOString().slice(0, 10);
  const label = a.longRun ? `long ${a.discipline}` : a.discipline;
  const main = `${date} ${label} ${formatDuration(a.durationS)}`;

  const m: Record<string, unknown> =
    a.metrics && typeof a.metrics === "object" && !Array.isArray(a.metrics)
      ? (a.metrics as Record<string, unknown>)
      : {};
  const distM = typeof m.distance_m === "number" ? m.distance_m : null;
  const paceS =
    typeof m.avg_pace_s_per_km === "number" ? m.avg_pace_s_per_km : null;
  const hr = typeof m.avg_hr === "number" ? Math.round(m.avg_hr) : null;

  const details: string[] = [];
  if (distM !== null && distM > 0) {
    let d = `${(distM / 1000).toFixed(1)} km`;
    if (paceS !== null && paceS > 0) d += ` @ ${formatPace(paceS)}`;
    details.push(d);
  }
  if (hr !== null) details.push(`HR ${hr}`);

  let base = details.length > 0 ? `  ${main} — ${details.join(", ")}` : `  ${main}`;
  // KER-80: append the streams shape when we have it.
  if (a.streamNote) base += ` [${a.streamNote}]`;
  // KER-80: the runner's own note on the activity (Strava description) is a
  // strong coaching signal. It's runner-controlled free text, so sanitize
  // before it enters the prompt: collapse newlines/quotes/control chars to
  // spaces (no breaking out of the line / forging context) and cap length.
  // Framed as untrusted runner text, not authoritative data (review).
  const rawDesc = typeof m.description === "string" ? m.description : "";
  const desc = rawDesc.replace(/[\x00-\x1f]+/g, " ").replace(/["`]/g, "").replace(/\s+/g, " ").trim();
  if (desc) base += ` — runner note (their words): ${desc.length > 140 ? `${desc.slice(0, 140)}…` : desc}`;
  return base;
}

// KER-78 (1b): the resolved-goal ground-truth line. Precedence (D1):
// active race block's goalFinishTime > the onboarding target_race fallback.
// Always carries an explicit "don't invent a time" guard — the bug was the
// LLM confabulating a target when the real one was absent or buried.
export function resolveGoalLine(
  block: FormatInput["block"],
  athleticHistory: unknown,
): string | null {
  const PREFIX = "Goal (ground truth): ";
  const GUARD = " Use this; do NOT invent or change the target time.";

  if (block) {
    if (block.goalFinishTime) {
      return `${PREFIX}${block.goalFinishTime} at ${block.raceName} (${block.raceDistance}) — from the active race plan.${GUARD}`;
    }
    return `${PREFIX}finish ${block.raceName} (${block.raceDistance}) — no target time set; do NOT invent one.`;
  }

  const tr = (athleticHistory as Record<string, unknown> | null)?.target_race;
  if (tr && typeof tr === "object") {
    const t = tr as Record<string, unknown>;
    const name = typeof t.name === "string" ? t.name : null;
    const dist = typeof t.distance === "string" ? t.distance : null;
    const goalTime = typeof t.goal_time === "string" ? t.goal_time : null;
    // C1 (review): the race DATE must stay in context — the plan generator
    // sizes the block and places the taper from it. We stripped target_race
    // from the JSON dump, so surface the date here or first-plan generation
    // (no active block yet) loses it.
    const date = typeof t.date === "string" ? t.date : null;
    const what = [dist, name && `(${name})`].filter(Boolean).join(" ") || "their race";
    const on = date ? ` on ${date}` : "";
    if (goalTime) {
      return `${PREFIX}${goalTime} for ${what}${on} — stated goal, no active race plan yet.${GUARD}`;
    }
    return `${PREFIX}finish ${what}${on} — stated goal, no target time set; do NOT invent one.`;
  }

  // No goal anywhere — say so rather than let the model fill the vacuum.
  return "Goal: not on file. If asked about a target time, say you don't have one yet and offer to set it — do NOT invent a time.";
}

// Plain-text, scannable, easy for an LLM to parse and for a human to
// debug. Each section is omitted entirely when empty so we don't waste
// tokens on "no active flags".
export function formatContext(input: FormatInput): string {
  const parts: string[] = [];

  // "Now" anchor — first line, so the LLM reads it before anything else.
  // RC2 (v1.3): include the clock TIME (LLMs invent it otherwise) and make
  // this the single source of truth — the LLM must not re-derive the day or
  // time, and must ignore any older city in the history that conflicts with
  // this timezone (e.g. after a "I'm in Tokyo now" override).
  if (input.zonedToday) {
    const { date, weekday, time, timezone } = input.zonedToday;
    const wd = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    // KER-78: state the resolved HOME city explicitly. Measured: with only
    // the timezone here, the LLM had no authoritative city and grabbed a
    // stale one from the message log 44% of the time (eval:grounding). The
    // fix is a concrete value to anchor on, not a vague "ignore conflicts".
    const homeLine = input.homeCity
      ? ` The runner's home is ${input.homeCity} — treat that as their ` +
        `current city unless they explicitly say they have permanently ` +
        `moved. Ignore any other city mentioned below (including in past ` +
        `messages); a place named on a trip is not where they live.`
      : ` (Home city not on file — do NOT guess it from past messages or ` +
        `the history; if asked where they live, say you don't have it yet.)`;
    parts.push(
      `Now (ground truth — use this, never compute the day/time yourself): ` +
        `${wd}, ${date}, ${time} in ${timezone}.${homeLine}`,
    );
  }

  // Profile line.
  const nameStr = input.name ?? "Unknown";
  parts.push(`Athlete: ${nameStr} (locale ${input.locale})`);

  // RC3 (v1.3): MARP's real capabilities, so the coaching LLM stops denying
  // features it actually has (it was telling runners "I can't send
  // reminders"). State them plainly; never claim you can't do these.
  parts.push(
    "MARP can: send WhatsApp reminders on training days (the runner sets a " +
      "time, or asks for the night before — just confirm and tell them it's " +
      "set), add sessions to their calendar, and read their Strava activity. " +
      "If the runner asks to be reminded, treat it as a real feature — never " +
      "say you can't send reminders or scheduled messages.",
  );

  // S2 (KER-30): age gate for minors. When the captured age is under 18,
  // hard-block weight/calorie/body-composition and menstrual-cycle content
  // — this line goes to every coaching domain, the synthesizer, AND the
  // plan generator (all read getMemoryContext).
  // Review (adversarial): coerce — the LLM extractor sometimes emits age as
  // a string ("17"). typeof === "number" alone would silently skip the gate
  // for a minor. Number() handles both; NaN/0/missing → no gate (can't gate
  // an unknown age).
  const ageRaw = (input.athleticHistory as Record<string, unknown> | null)?.age;
  const ageVal =
    typeof ageRaw === "number" || typeof ageRaw === "string" ? Number(ageRaw) : NaN;
  if (Number.isFinite(ageVal) && ageVal > 0 && ageVal < 18) {
    parts.push(
      "SAFEGUARD — this runner is under 18. Do NOT give weight-loss, " +
        "calorie-counting, body-composition, or menstrual-cycle advice, even " +
        "if asked. Keep coaching to training, technique, enjoyment, and simply " +
        "eating enough to fuel their running. If they raise those topics, " +
        "gently redirect and suggest talking to a parent/guardian or a doctor.",
    );
  }

  // KER-78 (1b): resolved goal as a single ground-truth line. Bug #2 was
  // the LLM inventing a target time (said 3:10 for a sub-4:30 runner)
  // because the goal was only buried in the history JSON or absent.
  // Precedence (D1): an active race block's goalFinishTime wins; otherwise
  // the onboarding target_race is a labelled fallback. Either way, ONE
  // authoritative line with an explicit "don't invent a time" guard.
  const goalLine = resolveGoalLine(input.block, input.athleticHistory);
  if (goalLine) parts.push(goalLine);

  // Athletic history JSON — but strip out the plan (rendered separately
  // below with real dates) and target_race (now surfaced as the resolved
  // goal line above; leaving it here would re-introduce a second, possibly
  // conflicting goal the LLM could grab).
  if (input.athleticHistory && typeof input.athleticHistory === "object") {
    const {
      plan: _plan,
      target_race: _tr,
      ...rest
    } = input.athleticHistory as Record<string, unknown>;
    if (Object.keys(rest).length > 0) {
      parts.push(`Athletic history: ${JSON.stringify(rest)}`);
    }
  }

  // Stored plan, rendered with concrete dates per session.
  if (input.plan) {
    parts.push(renderPlanForContext(input.plan));

    // KER-79 (Phase 2): computed adherence for the current week, so the LLM
    // reconciles prescription vs actual itself instead of conflating them
    // (bug #3: a 5k of a prescribed 10k long run was being called a long
    // run). Current week is derived from start_date + today — no cursor.
    if (input.zonedToday && input.activities && input.activities.length > 0) {
      const wk = currentWeekIndex(input.plan, input.zonedToday.date);
      const wa = computeWeekAdherence(
        input.plan,
        wk,
        input.activities,
        input.zonedToday.date,
        input.zonedToday.timezone,
      );
      const adherence = renderAdherenceLine(wa);
      if (adherence) parts.push(adherence);
    }
  }

  if (input.stravaStatus) {
    const hasActivities = (input.activities?.length ?? 0) > 0;
    let line: string;
    if (input.stravaStatus === "connected") {
      line = hasActivities
        ? "Strava: connected"
        : "Strava: connected (no activities recorded yet — only new/edited runs sync going forward)";
    } else if (input.stravaStatus === "revoked") {
      line =
        "Strava: previously connected but access was revoked — the runner needs to reconnect";
    } else {
      line = "Strava: not connected";
    }
    parts.push(line);
  }

  if (input.block) {
    // Count days-to-race from the runner's local "today" when we have it,
    // so the number doesn't drift by one near midnight in their timezone.
    const fromMs = input.zonedToday
      ? new Date(`${input.zonedToday.date}T00:00:00Z`).getTime()
      : Date.now();
    const raceMs = input.zonedToday
      ? new Date(`${input.block.raceDate.toISOString().slice(0, 10)}T00:00:00Z`).getTime()
      : input.block.raceDate.getTime();
    const days = Math.ceil((raceMs - fromMs) / 86400000);
    // Goal is stated once, above, in the resolved goal line — this line is
    // just the countdown so the two can't drift.
    parts.push(
      `Active race block: ${input.block.raceName} (${input.block.raceDistance}) — ${days} days away`,
    );
  }

  if (input.flags.length > 0) {
    const flagLines = input.flags
      .map((f) => `  - ${f.kind}: ${f.body} (since ${f.startedAt.toISOString().slice(0, 10)})`)
      .join("\n");
    parts.push(`Active flags:\n${flagLines}`);
  }

  // T8: past-block summaries — MARP's long-term memory. Each summary is
  // a couple paragraphs of free text. Render newest race first so older
  // context recedes naturally.
  if (input.pastBlocks && input.pastBlocks.length > 0) {
    const blockChunks = input.pastBlocks.map((b) => {
      const date = b.raceDate.toISOString().slice(0, 10);
      return `  [${date}] ${b.raceName} (${b.raceDistance}):\n${b.summary
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")}`;
    });
    parts.push(`Past blocks (newest first):\n${blockChunks.join("\n\n")}`);
  }

  if (input.activities && input.activities.length > 0) {
    const lines = input.activities.map(formatActivityLine).join("\n");
    parts.push(`Recent training (newest first):\n${lines}`);
  }

  if (input.messages.length > 0) {
    const msgLines = input.messages
      .map((m) => `  ${m.direction === "in" ? "RUNNER" : "MARP"}: ${m.body}`)
      .join("\n");
    parts.push(`Recent conversation (oldest first):\n${msgLines}`);
  }

  return parts.join("\n\n");
}
