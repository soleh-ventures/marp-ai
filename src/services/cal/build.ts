// V9 (v1.1 flow redesign) — calendar export builders.
//
// Two paths emitted side-by-side in every reminder:
//   1. ICS file — works for Apple Calendar / Outlook / iCal apps
//   2. Google Calendar quick-add URL — one-tap for the Google majority
//
// The reminder copy includes BOTH so the runner doesn't have to know
// which their calendar app uses. WhatsApp's preview UI handles long
// URLs poorly, so we keep both short by hosting the ICS as a signed
// route rather than inlining its contents.

import { config } from "../../config.js";
import type { PlanSession } from "../plan/types.js";

// ─── ICS file ────────────────────────────────────────────────────────────

// Builds an RFC 5545 VCALENDAR with a single VEVENT for one session.
// Times in floating local — we don't know the runner's local timezone
// inside the ICS file (parsers handle it as "the wall-clock time").
// Duration defaults to 60 minutes for sessions that don't specify
// duration_min — close enough for calendar slot reservation.
export function buildIcsForSession(
  session: PlanSession,
  sessionDate: string,
  timeLocal: string,
): string {
  const title = sessionTitle(session);
  const description = sessionDescription(session);
  const startLocal = composeDateTime(sessionDate, timeLocal);
  const durationMin = session.duration_min ?? 60;
  const endLocal = addMinutes(startLocal, durationMin);

  // Quoted-printable / escaping per RFC 5545 §3.3.11:
  //   commas, semicolons, backslashes → escaped; newlines → \n
  const esc = (s: string): string =>
    s.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");

  const uid = `${sessionDate}-${session.type}-${session.day_of_week}@marp`;
  const now = formatIcsTimestamp(new Date());

  // CRLF line endings per spec. Most parsers tolerate LF but the spec
  // is firm. Final blank line stripped by trim.
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MARP//Training Plan//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${esc(uid)}`,
    `DTSTAMP:${now}`,
    `DTSTART:${formatIcsLocal(startLocal)}`,
    `DTEND:${formatIcsLocal(endLocal)}`,
    `SUMMARY:${esc(title)}`,
    `DESCRIPTION:${esc(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ];
  return lines.join("\r\n");
}

// ─── Google quick-add URL ────────────────────────────────────────────────

export function buildGoogleQuickAddUrl(
  session: PlanSession,
  sessionDate: string,
  timeLocal: string,
): string {
  const title = sessionTitle(session);
  const description = sessionDescription(session);
  const startLocal = composeDateTime(sessionDate, timeLocal);
  const durationMin = session.duration_min ?? 60;
  const endLocal = addMinutes(startLocal, durationMin);

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${formatIcsLocal(startLocal)}/${formatIcsLocal(endLocal)}`,
    details: description,
  });

  return `https://www.google.com/calendar/render?${params.toString()}`;
}

// ─── Hosted ICS URL ──────────────────────────────────────────────────────

// Wraps a signed cal token into the public URL served by routes/cal.ts.
export function buildIcsUrl(token: string): string {
  const base = config.twilio.publicWebhookBase.replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "TWILIO_PUBLIC_WEBHOOK_BASE is not set — required for calendar URLs",
    );
  }
  return `${base}/cal/${encodeURIComponent(token)}.ics`;
}

// ─── shared helpers ──────────────────────────────────────────────────────

function sessionTitle(s: PlanSession): string {
  const dist = s.distance_km ? `${s.distance_km}km` : null;
  const dur = s.duration_min ? `${s.duration_min}min` : null;
  const size = [dist, dur].filter(Boolean).join("/");
  const typeLabel = s.type.charAt(0).toUpperCase() + s.type.slice(1);
  return size ? `${typeLabel}: ${size}` : typeLabel;
}

function sessionDescription(s: PlanSession): string {
  const lines = [s.description];
  if (s.reasoning) lines.push(`Why: ${s.reasoning}`);
  lines.push("Logged by MARP — your AI running companion.");
  return lines.join("\n");
}

type DateTimeParts = { y: number; M: number; d: number; h: number; m: number };

function composeDateTime(yyyymmdd: string, hhmm: string): DateTimeParts {
  const [yStr, MStr, dStr] = yyyymmdd.split("-");
  const [hStr, mStr] = hhmm.split(":");
  return {
    y: parseInt(yStr!, 10),
    M: parseInt(MStr!, 10),
    d: parseInt(dStr!, 10),
    h: parseInt(hStr!, 10),
    m: parseInt(mStr!, 10),
  };
}

function addMinutes(parts: DateTimeParts, minutes: number): DateTimeParts {
  // Treat as wall-clock (no TZ) — fold minutes through a Date built
  // from UTC-like fields so DST math doesn't bite us. We round-trip
  // through Date to handle hour/day overflow correctly.
  const base = new Date(Date.UTC(parts.y, parts.M - 1, parts.d, parts.h, parts.m));
  const incr = new Date(base.getTime() + minutes * 60_000);
  return {
    y: incr.getUTCFullYear(),
    M: incr.getUTCMonth() + 1,
    d: incr.getUTCDate(),
    h: incr.getUTCHours(),
    m: incr.getUTCMinutes(),
  };
}

function formatIcsLocal(p: DateTimeParts): string {
  return (
    `${p.y}${pad2(p.M)}${pad2(p.d)}T${pad2(p.h)}${pad2(p.m)}00`
  );
}

function formatIcsTimestamp(date: Date): string {
  return (
    date.getUTCFullYear().toString() +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    "T" +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    "Z"
  );
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
