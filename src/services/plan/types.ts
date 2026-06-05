// V6 (v1.1 flow redesign) — Plan jsonb schema.
//
// One canonical shape for both BYO-ingested plans and MARP-generated
// plans. Stored on athletes.athletic_history.plan (v1.1 MVP). A future
// migration moves this onto race_blocks.plan once the race-block
// lifecycle (creation on onboarding-complete) is wired in.
//
// Design choices:
//   - day_of_week is ISO-ish lowercase strings (not 0..6). More readable
//     in logs and the LLM emits these naturally.
//   - distance_km OR duration_min — sessions may have neither (rest), one,
//     or both. The LLM picks whichever the source gives.
//   - reasoning is the cite-the-principle one-liner from V7. Optional
//     for ingested plans (the runner's source may not include it).

export type DayOfWeek =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export type SessionType =
  | "easy"
  | "long"
  | "tempo"
  | "intervals"
  | "race"
  | "strides"
  | "cross"
  | "rest";

export type PlanSession = {
  day_of_week: DayOfWeek;
  type: SessionType;
  distance_km?: number;
  duration_min?: number;
  description: string;
  reasoning?: string;
};

export type PlanPhase = "base" | "build" | "peak" | "taper";

export type PlanWeek = {
  index: number;
  phase?: PlanPhase;
  total_km?: number;
  focus?: string;
  sessions: PlanSession[];
};

export type Plan = {
  version: 1;
  source: "ingested" | "generated";
  start_date: string;
  race_date?: string;
  race_name?: string;
  // F6 (v1.2): one-line statement of the frameworks the plan is built on
  // (e.g. "Pfitz base→build→peak→taper, 80/20 polarized, 10%-rule"). Shown
  // first in the summary so the runner sees it's a real, principled plan
  // without having to ask. Optional — ingested plans may not have one.
  methodology?: string;
  weeks: PlanWeek[];
  generated_at: string;
};

const DAYS: ReadonlySet<DayOfWeek> = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

const SESSION_TYPES: ReadonlySet<SessionType> = new Set([
  "easy",
  "long",
  "tempo",
  "intervals",
  "race",
  "strides",
  "cross",
  "rest",
]);

const PHASES: ReadonlySet<PlanPhase> = new Set([
  "base",
  "build",
  "peak",
  "taper",
]);

// Runtime validator — accepts the raw LLM output and returns a Plan
// or throws on malformed shape. We tolerate missing optional fields
// but reject any session that doesn't have day_of_week + type +
// description (the minimum to coach against). Unknown enum values
// are coerced to "easy" / "base" rather than rejected, since LLM
// vocabulary drift is more common than truly broken output.
export function parsePlan(raw: unknown): Plan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("plan: root must be an object");
  }
  const obj = raw as Record<string, unknown>;

  const source = obj.source === "ingested" ? "ingested" : "generated";
  const start_date =
    typeof obj.start_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(obj.start_date)
      ? obj.start_date.slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  const race_date =
    typeof obj.race_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(obj.race_date)
      ? obj.race_date.slice(0, 10)
      : undefined;
  const race_name = typeof obj.race_name === "string" ? obj.race_name : undefined;
  const methodology =
    typeof obj.methodology === "string" && obj.methodology.trim().length > 0
      ? obj.methodology.trim()
      : undefined;

  if (!Array.isArray(obj.weeks)) {
    throw new Error("plan: weeks must be an array");
  }
  const weeks: PlanWeek[] = obj.weeks.map((w, i) => parseWeek(w, i + 1));
  if (weeks.length === 0) {
    throw new Error("plan: at least one week is required");
  }

  return {
    version: 1,
    source,
    start_date,
    race_date,
    race_name,
    methodology,
    weeks,
    generated_at: new Date().toISOString(),
  };
}

function parseWeek(raw: unknown, fallbackIndex: number): PlanWeek {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`plan.week[${fallbackIndex}]: must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const index =
    typeof obj.index === "number" && obj.index > 0 ? Math.floor(obj.index) : fallbackIndex;
  const phase =
    typeof obj.phase === "string" && PHASES.has(obj.phase as PlanPhase)
      ? (obj.phase as PlanPhase)
      : undefined;
  const total_km =
    typeof obj.total_km === "number" && obj.total_km >= 0 ? obj.total_km : undefined;
  const focus = typeof obj.focus === "string" ? obj.focus : undefined;

  if (!Array.isArray(obj.sessions)) {
    throw new Error(`plan.week[${index}]: sessions must be an array`);
  }
  const sessions: PlanSession[] = obj.sessions.map((s, i) =>
    parseSession(s, index, i),
  );

  return { index, phase, total_km, focus, sessions };
}

function parseSession(
  raw: unknown,
  weekIndex: number,
  sessionIndex: number,
): PlanSession {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `plan.week[${weekIndex}].session[${sessionIndex}]: must be an object`,
    );
  }
  const obj = raw as Record<string, unknown>;

  const day_of_week =
    typeof obj.day_of_week === "string" && DAYS.has(obj.day_of_week.toLowerCase() as DayOfWeek)
      ? (obj.day_of_week.toLowerCase() as DayOfWeek)
      : null;
  if (!day_of_week) {
    throw new Error(
      `plan.week[${weekIndex}].session[${sessionIndex}]: day_of_week required`,
    );
  }

  const type =
    typeof obj.type === "string" && SESSION_TYPES.has(obj.type.toLowerCase() as SessionType)
      ? (obj.type.toLowerCase() as SessionType)
      : "easy";

  const description =
    typeof obj.description === "string" && obj.description.trim().length > 0
      ? obj.description.trim()
      : null;
  if (!description) {
    throw new Error(
      `plan.week[${weekIndex}].session[${sessionIndex}]: description required`,
    );
  }

  const distance_km =
    typeof obj.distance_km === "number" && obj.distance_km > 0 ? obj.distance_km : undefined;
  const duration_min =
    typeof obj.duration_min === "number" && obj.duration_min > 0 ? obj.duration_min : undefined;
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : undefined;

  return { day_of_week, type, distance_km, duration_min, description, reasoning };
}

// --- Calendar-date helpers ---
//
// A plan stores sessions as weekday strings (day_of_week) anchored to
// start_date (week-1's Monday, a local calendar date). The runner thinks
// in dates, not "week 4, Wednesday", and MARP must be able to map a
// weekday to a real date without doing arithmetic the LLM gets wrong.
// These helpers resolve every session to a concrete YYYY-MM-DD.

const DOW_INDEX: Record<DayOfWeek, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

// YYYY-MM-DD for a session. Pure calendar math on a UTC-midnight anchor —
// we only ever read Y-M-D back out (never a wall-clock time), so DST and
// timezone can't skew the result.
export function sessionDate(
  startDate: string,
  weekIndex: number,
  day: DayOfWeek,
): string {
  const base = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return startDate;
  const offset = (Math.max(1, weekIndex) - 1) * 7 + DOW_INDEX[day];
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

// "Mon 8 Jun" (or "Mon 8 Jun 2026" with year). Formatted in UTC so the
// printed day matches the calendar date exactly, regardless of server tz.
export function formatShortDate(isoDate: string, withYear = false): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(d);
}

// Sessions in calendar order (Mon→Sun), each as a dated one-liner the
// runner can act on: "Tue 9 Jun — Easy 8K @ 5:40/km Z2".
function renderWeekDays(plan: Plan, week: PlanWeek): string[] {
  return [...week.sessions]
    .sort((a, b) => DOW_INDEX[a.day_of_week] - DOW_INDEX[b.day_of_week])
    .map((s) => {
      const date = formatShortDate(sessionDate(plan.start_date, week.index, s.day_of_week));
      return `  ${date} — ${s.description}`;
    });
}

// Human-readable summary for the WhatsApp reply that follows generation /
// ingest. Goal: the runner reads it in under 30 seconds, sees the shape of
// the block, AND sees their actual first week laid out day-by-day with real
// dates — so nothing is ambiguous and they can spot anything that's off.
export function renderPlanSummary(plan: Plan): string {
  const lines: string[] = [];
  const verb = plan.source === "ingested" ? "Captured" : "Built";
  const raceBit = plan.race_name ? ` for ${plan.race_name}` : "";
  const raceDay = plan.race_date
    ? ` — race day ${formatShortDate(plan.race_date, true)}`
    : "";
  lines.push(`${verb} your ${plan.weeks.length}-week plan${raceBit}${raceDay}.`);

  // F6 (v1.2): lead with the method so the runner sees it's principled.
  if (plan.methodology) {
    lines.push(`Method: ${plan.methodology}`);
  }

  // Shape line: phases + peak week, when we have them.
  const shapeBits: string[] = [];
  const phases = [...new Set(plan.weeks.map((w) => w.phase).filter(Boolean))];
  if (phases.length > 0) shapeBits.push(phases.join(" → "));
  const withKm = plan.weeks.filter((w) => typeof w.total_km === "number");
  if (withKm.length > 0) {
    const peak = withKm.reduce((max, w) => (w.total_km! > max.total_km! ? w : max));
    shapeBits.push(`peak week ${peak.index} at ${peak.total_km}km`);
  }
  if (shapeBits.length > 0) lines.push(`Shape: ${shapeBits.join(" · ")}.`);

  // Week 1, laid out day-by-day with real dates — the part the runner
  // actually starts on. Rest days included so the week reads as a whole.
  const w1 = plan.weeks[0];
  if (w1) {
    const km = typeof w1.total_km === "number" ? `, ${w1.total_km}km` : "";
    const phase = w1.phase ? `${w1.phase}${km}` : km.replace(/^, /, "");
    const head = phase ? `Week 1 (${phase})` : "Week 1";
    const starts = `starts ${formatShortDate(plan.start_date)}`;
    lines.push("");
    lines.push(`${head} — ${starts}:`);
    lines.push(...renderWeekDays(plan, w1));
  }

  lines.push("");
  if (plan.weeks.length > 1) {
    lines.push(
      `${plan.weeks.length} weeks in total — ask me about any week and I'll walk you through it.`,
    );
  }
  lines.push("Look right? If anything's off, just tell me what to change.");

  return lines.join("\n");
}

// Dated, weekday-anchored rendering of the whole plan for the LLM's working
// memory. Replaces dumping the plan as raw JSON: every session carries its
// real calendar date, so when the runner asks "what's on today / tomorrow /
// this week" MARP reads the answer off concrete dates instead of doing
// weekday arithmetic (which LLMs get wrong).
export function renderPlanForContext(plan: Plan): string {
  const header: string[] = [];
  const raceBit = plan.race_name ? `, ${plan.race_name}` : "";
  const raceDay = plan.race_date
    ? `, race ${formatShortDate(plan.race_date, true)}`
    : "";
  header.push(`Training plan (${plan.weeks.length} weeks${raceBit}${raceDay}).`);
  if (plan.methodology) header.push(`Method: ${plan.methodology}`);

  const weekBlocks = plan.weeks.map((w) => {
    const start = formatShortDate(sessionDate(plan.start_date, w.index, "monday"));
    const end = formatShortDate(sessionDate(plan.start_date, w.index, "sunday"));
    const meta: string[] = [];
    if (w.phase) meta.push(w.phase);
    if (typeof w.total_km === "number") meta.push(`${w.total_km}km`);
    const metaStr = meta.length > 0 ? ` ${meta.join(", ")}` : "";
    const focus = w.focus ? ` — ${w.focus}` : "";
    const days = [...w.sessions]
      .sort((a, b) => DOW_INDEX[a.day_of_week] - DOW_INDEX[b.day_of_week])
      .map((s) => {
        const date = formatShortDate(sessionDate(plan.start_date, w.index, s.day_of_week));
        return `    ${date}: ${s.type} — ${s.description}`;
      })
      .join("\n");
    return `  Week ${w.index} [${start}–${end}]${metaStr}${focus}:\n${days}`;
  });

  return `${header.join(" ")}\n${weekBlocks.join("\n")}`;
}
