// V9 (v1.1 flow redesign) — calendar ICS hosting route.
//
// GET /cal/:token.ics
//
// Verifies the HMAC-signed cal token, looks up the matching session
// from the athlete's stored plan, returns an RFC 5545 ICS file.
//
// Public endpoint — anyone who has the token can fetch the file.
// Threat surface:
//   - Token leak in URL bar / browser history → calendar event
//     exposed (training session description). Low sensitivity; the
//     plan itself is the secret, not individual sessions.
//   - Tokens expire at session_date + 1 day, so leaks have short half-life.
//   - HMAC verify rejects forgery; constant-time compare in verifyCalToken.
//
// No DB write — purely a read + render. No rate limit applied since
// the URL is bound to one athlete + one session.

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { athletes } from "../db/schema.js";
import { buildIcsForSession } from "../services/cal/build.js";
import { verifyCalToken } from "../services/cal/token.js";
import { getAthleticHistory } from "../flows/onboarding.js";
import { readPrefs } from "../services/reminders/prefs.js";
import { getStoredPlan } from "../services/plan/storage.js";
import type { PlanSession } from "../services/plan/types.js";

export const cal = new Hono();

cal.get("/:tokenWithExt", async (c) => {
  const tokenWithExt = c.req.param("tokenWithExt");
  // Strip ".ics" suffix — clients (and our own URL builder) include it
  // so the response is treated as a calendar by the browser.
  const token = tokenWithExt.endsWith(".ics")
    ? tokenWithExt.slice(0, -4)
    : tokenWithExt;

  const v = verifyCalToken(token);
  if (!v.ok) {
    const status = v.reason === "expired" ? 410 : 403;
    return c.text(v.reason, status);
  }

  const { athleteId, sessionDate } = v.payload;

  const rows = await db
    .select({
      name: athletes.name,
      athleticHistory: athletes.athleticHistory,
      reminderPrefs: athletes.reminderPrefs,
    })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  const row = rows[0];
  if (!row) return c.text("not found", 404);

  const history = getAthleticHistory(row.athleticHistory);
  const plan = getStoredPlan(history);
  if (!plan) return c.text("no plan", 404);

  const session = findSessionForDate(plan.weeks, plan.start_date, sessionDate);
  if (!session) return c.text("no session", 404);

  const prefs = readPrefs(row.reminderPrefs);
  // Default to 07:00 if the runner hasn't set a reminder time — gives
  // the calendar event a sensible slot rather than midnight.
  const timeLocal = prefs?.time_local ?? "07:00";

  const ics = buildIcsForSession(session, sessionDate, timeLocal);
  return c.body(ics, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": `attachment; filename="marp-${sessionDate}.ics"`,
    "Cache-Control": "private, max-age=3600",
  });
});

function findSessionForDate(
  weeks: Array<{ index: number; sessions: PlanSession[] }>,
  start_date: string,
  target_date: string,
): PlanSession | null {
  const start = new Date(`${start_date}T00:00:00Z`);
  const target = new Date(`${target_date}T00:00:00Z`);
  const dayDiff = Math.floor(
    (target.getTime() - start.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (dayDiff < 0) return null;

  const weekIndex = Math.floor(dayDiff / 7) + 1;
  const week = weeks.find((w) => w.index === weekIndex);
  if (!week) return null;

  // Day-of-week of the target_date in UTC. Sunday=0..Saturday=6.
  const jsDay = target.getUTCDay();
  const map = [
    "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
  ] as const;
  const dow = map[jsDay];
  return week.sessions.find((s) => s.day_of_week === dow) ?? null;
}
