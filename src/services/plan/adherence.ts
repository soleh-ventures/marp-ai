// KER-79 (Grounded Coach, Phase 2) — read-time plan adherence.
//
// The "5k called a long run" bug (#3) came from the coaching LLM reading the
// PRESCRIPTION ("today: long run 10k") and the ACTIVITY ("5k") as two
// separate facts and never reconciling them. Adherence is a deterministic
// join of prescribed sessions ↔ actual activities, computed at read time —
// NOT stored in the plan blob (adjustPlan round-trips the whole plan through
// an LLM and would corrupt stored actuals). No schema change, no cursor:
// the current week is derived from start_date + today, so old v1 plans work
// unchanged (no migration trap).

import {
  type DayOfWeek,
  type Plan,
  type PlanSession,
  sessionDate,
} from "./types.js";

// The minimal activity shape adherence needs. Matches what getMemoryContext
// already selects (memory/retrieve.ts ActivityRow), so callers pass rows
// straight through.
export type AdherenceActivity = {
  discipline: string;
  startedAt: Date;
  durationS: number;
  metrics: unknown;
};

export type SessionStatus =
  | "done" // actual met the prescription (within tolerance)
  | "short" // ran, but well under the prescribed distance/duration
  | "over" // ran well over (worth noting — could be overreaching)
  | "wrong_discipline" // did something, but not what was prescribed (planned run, did a ride)
  | "missed" // prescribed day is past and nothing matched
  | "upcoming"; // prescribed day is today-or-future — not yet due

export type SessionAdherence = {
  date: string; // YYYY-MM-DD
  prescribed: PlanSession;
  status: SessionStatus;
  actualKm: number | null;
  actualMin: number | null;
  actualDiscipline: string | null;
};

export type ExtraActivity = {
  date: string;
  discipline: string;
  km: number | null;
};

export type WeekAdherence = {
  weekIndex: number;
  start: string;
  end: string;
  sessions: SessionAdherence[]; // prescribed sessions (rest days excluded)
  extras: ExtraActivity[]; // activities with no matching prescribed session
};

// Tolerance bands on the prescribed amount.
const SHORT_BELOW = 0.8;
const OVER_ABOVE = 1.2;

const DOW_ORDER: DayOfWeek[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

// The activity's calendar day in the athlete's timezone (YYYY-MM-DD).
// Prescribed session dates are athlete-local, so activities must be bucketed
// in the same frame — bucketing by UTC mis-files a run done in the early or
// late local hours onto the wrong day (review: HIGH). Falls back to UTC when
// no timezone is known.
function localDay(d: Date, tz: string | null | undefined): string {
  if (!tz) return d.toISOString().slice(0, 10);
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function distanceKm(metrics: unknown): number | null {
  if (!metrics || typeof metrics !== "object") return null;
  const m = metrics as Record<string, unknown>;
  return typeof m.distance_m === "number" && m.distance_m > 0
    ? m.distance_m / 1000
    : null;
}

// What discipline a prescribed session expects. Runs collapse to "run"
// (matching strava-activities mapSportType); "cross" stays cross; rest has none.
function prescribedDiscipline(type: PlanSession["type"]): string | null {
  if (type === "rest") return null;
  if (type === "cross") return "cross";
  return "run";
}

// Which plan week contains `todayISO`. Computed from start_date — never
// stored. Before the plan starts → week 1; after the last week → weeks.length.
export function currentWeekIndex(plan: Plan, todayISO: string): number {
  const total = plan.weeks.length;
  for (let i = 1; i <= total; i++) {
    const start = sessionDate(plan.start_date, i, "monday");
    const end = sessionDate(plan.start_date, i, "sunday");
    if (todayISO >= start && todayISO <= end) return i;
  }
  // Before week 1 starts.
  if (todayISO < sessionDate(plan.start_date, 1, "monday")) return 1;
  // Past the end.
  return total;
}

// Join one week's prescribed sessions to the actual activities. Pure +
// deterministic. `todayISO` decides which prescribed days are "missed" (past)
// vs "upcoming" (today or later) so mid-week we never call a not-yet-due
// session missed.
export function computeWeekAdherence(
  plan: Plan,
  weekIndex: number,
  activities: AdherenceActivity[],
  todayISO: string,
  timezone?: string | null,
): WeekAdherence {
  const week = plan.weeks.find((w) => w.index === weekIndex);
  const start = sessionDate(plan.start_date, weekIndex, "monday");
  const end = sessionDate(plan.start_date, weekIndex, "sunday");

  // Activities that fall inside this week, by the athlete's LOCAL calendar day
  // (same frame as the prescribed session dates).
  const inWeek = activities
    .map((a) => ({ a, day: localDay(a.startedAt, timezone) }))
    .filter(({ day }) => day >= start && day <= end);
  const claimed = new Set<number>(); // indices of inWeek consumed by a session

  const sessions: SessionAdherence[] = [];
  for (const s of week?.sessions ?? []) {
    if (s.type === "rest") continue;
    const date = sessionDate(plan.start_date, weekIndex, s.day_of_week);
    const want = prescribedDiscipline(s.type);

    // Candidate activities on that calendar day, not yet claimed.
    const sameDay = inWeek
      .map((x, i) => ({ ...x, i }))
      .filter((x) => x.day === date && !claimed.has(x.i));
    // Prefer a discipline match; otherwise take any same-day activity.
    const match =
      sameDay.find((x) => x.a.discipline === want) ?? sameDay[0] ?? null;

    if (!match) {
      sessions.push({
        date,
        prescribed: s,
        status: date <= todayISO ? "missed" : "upcoming",
        actualKm: null,
        actualMin: null,
        actualDiscipline: null,
      });
      continue;
    }
    claimed.add(match.i);
    const actualKm = distanceKm(match.a.metrics);
    const actualMin = Math.round(match.a.durationS / 60);

    let status: SessionStatus;
    if (want && match.a.discipline !== want) {
      status = "wrong_discipline";
    } else if (typeof s.distance_km === "number" && actualKm !== null) {
      status =
        actualKm < s.distance_km * SHORT_BELOW
          ? "short"
          : actualKm > s.distance_km * OVER_ABOVE
            ? "over"
            : "done";
    } else if (typeof s.duration_min === "number") {
      status =
        actualMin < s.duration_min * SHORT_BELOW
          ? "short"
          : actualMin > s.duration_min * OVER_ABOVE
            ? "over"
            : "done";
    } else {
      status = "done"; // prescribed had no target amount — showing up counts
    }

    sessions.push({
      date,
      prescribed: s,
      status,
      actualKm,
      actualMin,
      actualDiscipline: match.a.discipline,
    });
  }

  const extras: ExtraActivity[] = inWeek
    .map((x, i) => ({ ...x, i }))
    .filter((x) => !claimed.has(x.i))
    .map((x) => ({ date: x.day, discipline: x.a.discipline, km: distanceKm(x.a.metrics) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Keep prescribed sessions in calendar order for rendering.
  sessions.sort((a, b) => a.date.localeCompare(b.date));
  void DOW_ORDER; // ordering is by date; DOW kept for reference
  return { weekIndex, start, end, sessions, extras };
}

// One-line, LLM-facing adherence summary for the current week. Surfaced as a
// computed fact in the coaching context so the model stops conflating a
// short/skipped session with the prescription (bug #3). Returns null when
// there's nothing to say yet (no prescribed sessions due).
export function renderAdherenceLine(wa: WeekAdherence): string | null {
  const due = wa.sessions.filter((s) => s.status !== "upcoming");
  if (due.length === 0 && wa.extras.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const s of due) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const done = counts.done ?? 0;

  const notes: string[] = [];
  for (const s of wa.sessions) {
    if (s.status === "short") {
      const want = s.prescribed.distance_km;
      notes.push(
        `${s.date} ${s.prescribed.type}: ran ${s.actualKm ?? "?"}km of a prescribed ${want ?? "?"}km — SHORT, not a completed ${s.prescribed.type}`,
      );
    } else if (s.status === "missed") {
      notes.push(`${s.date} ${s.prescribed.type}: missed (no activity)`);
    } else if (s.status === "wrong_discipline") {
      notes.push(
        `${s.date} prescribed ${s.prescribed.type} but did ${s.actualDiscipline}`,
      );
    } else if (s.status === "over") {
      notes.push(
        `${s.date} ${s.prescribed.type}: ran ${s.actualKm ?? "?"}km, well over the prescribed ${s.prescribed.distance_km ?? "?"}km`,
      );
    }
  }
  for (const e of wa.extras) {
    notes.push(`${e.date}: extra ${e.discipline}${e.km ? ` ${e.km}km` : ""} (not in the plan)`);
  }

  const head = `Week ${wa.weekIndex} adherence (computed, ground truth): ${done}/${due.length} prescribed sessions done.`;
  const tail = notes.length > 0 ? ` Notable: ${notes.join("; ")}.` : "";
  return `${head}${tail} Use these facts; do not call a short or missed session complete.`;
}
