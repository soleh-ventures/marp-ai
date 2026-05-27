import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  activeFlags,
  activities,
  athletes,
  messages,
  raceBlocks,
} from "../db/schema.js";

// How many recent inbound + outbound messages to surface to the LLM as
// dialog context. 20 is roughly the last week of chat at typical cadence
// — small enough not to balloon prompt cost, long enough to catch
// "wait, you told me yesterday…" callbacks.
const RECENT_MESSAGE_LIMIT = 20;

// How many recent activities (any source — Strava, FIT, GPX) to surface.
// 14 covers roughly the last 1–2 weeks of consistent training; runners
// who train less frequently get a longer time window naturally.
const RECENT_ACTIVITY_LIMIT = 14;

export type MemoryContext = {
  // The formatted string the router feeds to the domain LLMs.
  text: string;
  // Counts surfaced for tests + observability — no need for raw rows
  // outside this module.
  athleteName: string | null;
  activeFlagCount: number;
  recentMessageCount: number;
  recentActivityCount: number;
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

  // Recent activities. Newest first — the LLM wants to know what the
  // runner *just* did to ground "how did that go" / "what's next" replies.
  const activityRows = await db
    .select({
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

  return {
    text: formatContext({
      name: athlete.name,
      locale: athlete.locale,
      athleticHistory: athlete.athleticHistory,
      flags: flagRows,
      block,
      messages: recentChrono,
      activities: activityRows,
    }),
    athleteName: athlete.name,
    activeFlagCount: flagRows.length,
    recentMessageCount: recentChrono.length,
    recentActivityCount: activityRows.length,
  };
}

export type ActivityRow = {
  discipline: string;
  startedAt: Date;
  durationS: number;
  metrics: unknown;
  longRun: boolean;
};

type FormatInput = {
  name: string | null;
  locale: string;
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
  messages: Array<{
    direction: "in" | "out";
    body: string;
    receivedAt: Date;
  }>;
  activities?: Array<ActivityRow>;
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

  return details.length > 0 ? `  ${main} — ${details.join(", ")}` : `  ${main}`;
}

// Plain-text, scannable, easy for an LLM to parse and for a human to
// debug. Each section is omitted entirely when empty so we don't waste
// tokens on "no active flags".
export function formatContext(input: FormatInput): string {
  const parts: string[] = [];

  // Profile line.
  const nameStr = input.name ?? "Unknown";
  parts.push(`Athlete: ${nameStr} (locale ${input.locale})`);

  if (input.athleticHistory && typeof input.athleticHistory === "object") {
    parts.push(
      `Athletic history: ${JSON.stringify(input.athleticHistory)}`,
    );
  }

  if (input.block) {
    const days = Math.ceil(
      (input.block.raceDate.getTime() - Date.now()) / 86400000,
    );
    const goal = input.block.goalFinishTime
      ? ` goal ${input.block.goalFinishTime}`
      : "";
    parts.push(
      `Active race block: ${input.block.raceName} (${input.block.raceDistance})${goal} — ${days} days away`,
    );
  }

  if (input.flags.length > 0) {
    const flagLines = input.flags
      .map((f) => `  - ${f.kind}: ${f.body} (since ${f.startedAt.toISOString().slice(0, 10)})`)
      .join("\n");
    parts.push(`Active flags:\n${flagLines}`);
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
