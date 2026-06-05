// V8 (v1.1 flow redesign) — reminder scheduler.
//
// Called by /internal/cron/reminders every 15 minutes. Finds every
// athlete whose reminder time falls in the current 15-minute window
// (in their local timezone) AND whose plan has a non-rest session
// today. Sends one templated WhatsApp message per match.
//
// Guards:
//  - Skip archived athletes.
//  - Skip athletes without a timezone (fail-safe — never send a
//    wrong-time reminder).
//  - Skip athletes with reminder_prefs.enabled=false or null.
//  - Skip when the day's session is "rest".
//  - Skip when there's no plan stored.
//
// Idempotency for v1.1: the 15-min cadence means a given athlete +
// time-local cell only matches once per day (the cron fires through
// the 15-min window once). If the cron fails mid-run, some athletes
// may miss their reminder for that day. Acceptable trade-off for v1.1
// — the alternative (per-day idempotency table) is V8.1 scope.

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { athletes } from "../../db/schema.js";
import { getAthleticHistory } from "../../flows/onboarding.js";
import { getStoredPlan } from "../plan/storage.js";
import type { DayOfWeek, PlanSession } from "../plan/types.js";
import { sendWhatsApp } from "../twilio-send.js";
import { readPrefs } from "./prefs.js";
import { buildReminderText } from "./templates.js";
import { buildGoogleQuickAddUrl, buildIcsUrl } from "../cal/build.js";
import { generateCalToken } from "../cal/token.js";
import { config } from "../../config.js";

export type SchedulerStats = {
  considered: number;
  skipped_no_tz: number;
  skipped_disabled: number;
  skipped_not_in_window: number;
  skipped_no_plan: number;
  skipped_rest_day: number;
  sent: number;
  failed: number;
};

// Fires every 15 min. We treat "in this window" as "the prefs time
// is within [now, now + 15min)" in the athlete's local time. The cron
// is meant to be scheduled at :00 :15 :30 :45 — at :02 a 6:00 reminder
// still fires (within window of 6:00..6:15). At 6:17 it does NOT fire
// (next match would be tomorrow 6:00).
const WINDOW_MINUTES = 15;

export async function runReminderScheduler(opts: {
  now: Date;
}): Promise<SchedulerStats> {
  const stats: SchedulerStats = {
    considered: 0,
    skipped_no_tz: 0,
    skipped_disabled: 0,
    skipped_not_in_window: 0,
    skipped_no_plan: 0,
    skipped_rest_day: 0,
    sent: 0,
    failed: 0,
  };

  const candidates = await db
    .select({
      id: athletes.id,
      phone: athletes.phone,
      name: athletes.name,
      timezone: athletes.timezone,
      reminderPrefs: athletes.reminderPrefs,
      athleticHistory: athletes.athleticHistory,
    })
    .from(athletes)
    .where(
      and(
        isNull(athletes.archivedAt),
        isNotNull(athletes.timezone),
        isNotNull(athletes.reminderPrefs),
      ),
    );

  for (const c of candidates) {
    stats.considered++;

    if (!c.timezone) {
      stats.skipped_no_tz++;
      continue;
    }
    const prefs = readPrefs(c.reminderPrefs);
    if (!prefs || !prefs.enabled || !prefs.time_local) {
      stats.skipped_disabled++;
      continue;
    }

    if (!isInLocalWindow(opts.now, c.timezone, prefs.time_local, WINDOW_MINUTES)) {
      stats.skipped_not_in_window++;
      continue;
    }

    const history = getAthleticHistory(c.athleticHistory);
    const plan = getStoredPlan(history);
    if (!plan) {
      stats.skipped_no_plan++;
      continue;
    }

    // F7: night_before reminders fire the evening BEFORE a training day,
    // so they describe TOMORROW's session (offset = 1). morning_of fires
    // on the day itself (offset = 0).
    const nightBefore = prefs.timing === "night_before";
    const offset = nightBefore ? 1 : 0;

    const session = findSessionForOffset(
      plan.weeks,
      opts.now,
      c.timezone,
      plan.start_date,
      offset,
    );
    if (!session || session.type === "rest") {
      stats.skipped_rest_day++;
      continue;
    }

    // V9: build calendar links for the session's date. Skip silently if
    // the public base isn't configured (dev) — reminders still ship
    // without the links.
    const sessionDate = localDateStringForOffset(opts.now, c.timezone, offset);
    let icsUrl: string | undefined;
    let googleUrl: string | undefined;
    if (sessionDate && config.twilio.publicWebhookBase) {
      try {
        const token = generateCalToken(c.id, sessionDate);
        icsUrl = buildIcsUrl(token);
        googleUrl = buildGoogleQuickAddUrl(session, sessionDate, prefs.time_local);
      } catch (err) {
        console.error(
          `reminder: cal link build failed for athlete ${c.id}: ${(err as Error).message}`,
        );
      }
    }

    const text = buildReminderText({
      name: c.name ?? "you",
      session,
      icsUrl,
      googleUrl,
      nightBefore,
    });
    try {
      await sendWhatsApp(c.phone, text);
      stats.sent++;
    } catch (err) {
      console.error(
        `reminder send failed for athlete ${c.id}: ${(err as Error).message}`,
      );
      stats.failed++;
    }
  }

  return stats;
}

// Returns YYYY-MM-DD of "today + dayOffset days" in the athlete's local
// timezone. offset 0 = today, 1 = tomorrow (F7 night-before reminders).
function localDateStringForOffset(
  now: Date,
  timezone: string,
  dayOffset: number,
): string | null {
  const parts = getLocalParts(now, timezone);
  if (!parts) return null;
  const d = new Date(`${parts.year}-${pad(parts.month)}-${pad(parts.day)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString().slice(0, 10);
}

// Returns true when the athlete's local "now" is within [time_local,
// time_local + window). Uses Intl.DateTimeFormat for timezone math —
// no external dep, handles DST.
export function isInLocalWindow(
  now: Date,
  timezone: string,
  time_local: string,
  windowMinutes: number,
): boolean {
  const parts = getLocalParts(now, timezone);
  if (!parts) return false;

  const [hStr, mStr] = time_local.split(":");
  const targetH = parseInt(hStr ?? "0", 10);
  const targetM = parseInt(mStr ?? "0", 10);
  if (isNaN(targetH) || isNaN(targetM)) return false;

  const nowMinutes = parts.hour * 60 + parts.minute;
  const targetMinutes = targetH * 60 + targetM;
  return nowMinutes >= targetMinutes && nowMinutes < targetMinutes + windowMinutes;
}

type LocalParts = { hour: number; minute: number; dayOfWeek: DayOfWeek; year: number; month: number; day: number };

function getLocalParts(now: Date, timezone: string): LocalParts | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = fmt.formatToParts(now);
    const hourStr = parts.find((p) => p.type === "hour")?.value;
    const minuteStr = parts.find((p) => p.type === "minute")?.value;
    const weekday = parts.find((p) => p.type === "weekday")?.value?.toLowerCase();
    const yearStr = parts.find((p) => p.type === "year")?.value;
    const monthStr = parts.find((p) => p.type === "month")?.value;
    const dayStr = parts.find((p) => p.type === "day")?.value;
    if (!hourStr || !minuteStr || !weekday || !yearStr || !monthStr || !dayStr) {
      return null;
    }
    const hour = parseInt(hourStr, 10) === 24 ? 0 : parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);
    const valid: DayOfWeek[] = [
      "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    ];
    if (!valid.includes(weekday as DayOfWeek)) return null;
    return {
      hour,
      minute,
      dayOfWeek: weekday as DayOfWeek,
      year: parseInt(yearStr, 10),
      month: parseInt(monthStr, 10),
      day: parseInt(dayStr, 10),
    };
  } catch {
    return null;
  }
}

// Find the session in plan.weeks for "today + dayOffset" in the athlete's
// timezone. offset 0 = today (morning_of), 1 = tomorrow (night_before).
// Returns null if the target day is before the plan starts, past its end,
// or has no session.
export function findSessionForOffset(
  weeks: Array<{ index: number; sessions: PlanSession[] }>,
  now: Date,
  timezone: string,
  start_date: string,
  dayOffset: number,
): PlanSession | null {
  const parts = getLocalParts(now, timezone);
  if (!parts) return null;

  // Target local date = today (in tz) + offset days. Adding whole UTC days
  // to a UTC-midnight anchor is safe — we only read Y-M-D + weekday back.
  const target = new Date(
    `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T00:00:00Z`,
  );
  target.setUTCDate(target.getUTCDate() + dayOffset);

  const startDate = new Date(`${start_date}T00:00:00Z`);
  const dayDiff = Math.floor(
    (target.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (dayDiff < 0) return null;

  const weekIndex = Math.floor(dayDiff / 7) + 1;
  const week = weeks.find((w) => w.index === weekIndex);
  if (!week) return null;

  const targetDow = DOW_ORDER[target.getUTCDay()];
  return week.sessions.find((s) => s.day_of_week === targetDow) ?? null;
}

// JS getUTCDay(): 0 = Sunday … 6 = Saturday.
const DOW_ORDER: DayOfWeek[] = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
