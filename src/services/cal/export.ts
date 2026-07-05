// Whole-plan calendar export — the plan's body outside chat scroll-back.
//
// One VEVENT per non-rest session across the entire plan, with descriptions
// that COACH (what, why, week focus), served two ways from one route:
//   - webcal:// subscription (Google "From URL" / Apple Calendar) — the feed
//     re-renders from the CURRENT stored plan on every fetch, so plan changes
//     propagate on the next poll with zero OAuth and zero sync state.
//   - one-time .ics download/import.
//
// Times stay floating wall-clock (consistent with build.ts — the calendar
// app interprets them in the device's local timezone). DTSTART comes from
// the athlete's preferred_time mapping; reminderPrefs.time_local is used
// ONLY when timing === "morning_of" (night_before is a REMINDER time — using
// it here scheduled workouts at 21:00 the previous night, a live bug in the
// per-session route this module fixes by owning the rule).
//
// UID note: `${date}-${type}@marp-plan` collides if a plan ever puts two
// same-type sessions on one date. The plan schema keys sessions by
// day_of_week (one per day), so this is theoretical; a replace-the-world
// subscription feed also self-heals on the next poll. Documented, accepted,
// pinned in the golden-file test. No SEQUENCE needed for the same reason.

import type { Plan, PlanSession, PlanWeek } from "../plan/types.js";

const CRLF = "\r\n";

export type FeedTimeSource = {
  preferredTime?: unknown; // athleticHistory.preferred_time
  reminderPrefs?: { time_local?: string; timing?: string } | null;
};

// morning 07:00 / lunch 12:00 / evening 18:00 — the plan's mapping.
export function resolveSessionTime(src: FeedTimeSource): string {
  const rp = src.reminderPrefs;
  if (rp?.time_local && rp.timing === "morning_of") return rp.time_local;
  const pref = typeof src.preferredTime === "string" ? src.preferredTime : "";
  if (pref === "morning") return "07:00";
  if (pref === "lunch") return "12:00";
  if (pref === "evening") return "18:00";
  return "07:00";
}

// RFC 5545 §3.3.11 text escaping. Strips raw \r first — a CR smuggled
// through plan text would otherwise inject a literal line break into the
// feed (eng amendment 9).
function esc(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\n/g, "\\n");
}

// RFC 5545 §3.1 line folding: lines longer than 75 OCTETS continue on the
// next line after CRLF + one space. Octet-based (emoji are 4 bytes), so we
// fold by bytes, careful never to split a UTF-8 sequence.
export function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    const budget = first ? 75 : 74; // continuation lines carry a leading space
    let end = Math.min(start + budget, bytes.length);
    // Don't split inside a UTF-8 multi-byte sequence: back up while the byte
    // at `end` is a continuation byte (10xxxxxx).
    while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) {
      end--;
    }
    out.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    first = false;
  }
  return out.join(`${CRLF} `);
}

const DAY_OFFSET: Record<string, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

function sessionDate(startDate: string, weekIndex: number, dayOfWeek: string): string {
  const start = new Date(`${startDate}T00:00:00Z`);
  const offset = (weekIndex - 1) * 7 + (DAY_OFFSET[dayOfWeek] ?? 0);
  const d = new Date(start.getTime() + offset * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function icsDateTime(date: string, hhmm: string, addMinutes = 0): string {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  const base = new Date(`${date}T00:00:00Z`);
  const t = new Date(base.getTime() + ((h ?? 7) * 60 + (m ?? 0) + addMinutes) * 60_000);
  const p = (n: number) => n.toString().padStart(2, "0");
  return (
    `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}` +
    `T${p(t.getUTCHours())}${p(t.getUTCMinutes())}00`
  );
}

function feedTitle(s: PlanSession, week: PlanWeek): string {
  const dist = s.distance_km ? `${s.distance_km}km` : null;
  const dur = s.duration_min ? `${s.duration_min}min` : null;
  const size = [dist, dur].filter(Boolean).join(" / ");
  const typeLabel = s.type.charAt(0).toUpperCase() + s.type.slice(1);
  const core = size ? `${typeLabel} ${size}` : typeLabel;
  return `🏃 ${core} — MARP W${week.index}`;
}

// A description that coaches: the instruction, the why, and where the week
// sits in the arc.
function feedDescription(s: PlanSession, week: PlanWeek): string {
  const lines = [s.description];
  if (s.reasoning) lines.push(`Why: ${s.reasoning}`);
  const weekBits = [
    `Week ${week.index}`,
    week.phase ? `(${week.phase})` : null,
    week.focus ? `— ${week.focus}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  lines.push(weekBits);
  lines.push("Your MARP training plan — updates automatically when the plan changes.");
  return lines.join("\n");
}

// Build the whole-plan VCALENDAR. `now` injectable for golden-file tests.
export function buildPlanFeed(
  plan: Plan,
  time: FeedTimeSource,
  opts: { now?: Date } = {},
): string {
  const timeLocal = resolveSessionTime(time);
  const now = opts.now ?? new Date();
  const p = (n: number) => n.toString().padStart(2, "0");
  const dtstamp =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MARP//Training Plan Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:MARP Training Plan",
    "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
  ];

  for (const week of plan.weeks) {
    for (const s of week.sessions) {
      if (s.type === "rest") continue;
      const date = sessionDate(plan.start_date, week.index, s.day_of_week);
      const durationMin = s.duration_min ?? 60;
      lines.push(
        "BEGIN:VEVENT",
        `UID:${esc(`${date}-${s.type}@marp-plan`)}`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART:${icsDateTime(date, timeLocal)}`,
        `DTEND:${icsDateTime(date, timeLocal, durationMin)}`,
        `SUMMARY:${esc(feedTitle(s, week))}`,
        `DESCRIPTION:${esc(feedDescription(s, week))}`,
        "END:VEVENT",
      );
    }
  }

  lines.push("END:VCALENDAR", "");
  return lines.map(foldIcsLine).join(CRLF);
}
