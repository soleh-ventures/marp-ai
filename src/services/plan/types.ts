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

// Compact human-readable summary for the WhatsApp reply that follows
// generation / ingest. Goal: runner reads it in under 30 seconds and
// can spot anything that doesn't match their reality.
export function renderPlanSummary(plan: Plan): string {
  const lines: string[] = [];
  const verb = plan.source === "ingested" ? "Captured" : "Built";
  const title = plan.race_name
    ? `${verb} a ${plan.weeks.length}-week plan for ${plan.race_name}`
    : `${verb} a ${plan.weeks.length}-week plan`;
  lines.push(title + (plan.race_date ? ` (${plan.race_date}).` : "."));

  // F6 (v1.2): lead with the method so the runner sees it's principled.
  if (plan.methodology) {
    lines.push(`Built on: ${plan.methodology}`);
  }

  // Phase summary if present
  const phases = new Set(plan.weeks.map((w) => w.phase).filter(Boolean));
  if (phases.size > 0) {
    lines.push(`Phases: ${[...phases].join(" → ")}.`);
  }

  // Peak week
  const withKm = plan.weeks.filter((w) => typeof w.total_km === "number");
  if (withKm.length > 0) {
    const peak = withKm.reduce((max, w) => (w.total_km! > max.total_km! ? w : max));
    lines.push(`Peak week ${peak.index}: ${peak.total_km}km.`);
  }

  // Sample week 1 sessions
  const w1 = plan.weeks[0];
  if (w1) {
    const sampleSessions = w1.sessions
      .filter((s) => s.type !== "rest")
      .slice(0, 3)
      .map((s) => `${s.day_of_week.slice(0, 3)} ${s.description}`);
    if (sampleSessions.length > 0) {
      lines.push(`Week 1: ${sampleSessions.join(" · ")}.`);
    }
  }

  lines.push("");
  lines.push("Look right? If anything's off, just tell me what to change.");

  return lines.join("\n");
}
