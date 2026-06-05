// V8 (v1.1 flow redesign) — cron entry point for reminder dispatch.
//
// Hit by Railway's cron scheduler every 15 minutes. Auth via the
// X-Cron-Secret header (compared with CRON_SECRET env). The endpoint
// returns a small JSON stats object so cron logs surface what fired.
//
// Security:
//   - Wrong / missing header → 403 with empty body (no info leak)
//   - Rate limiting NOT applied — cron hits once per 15 min from a
//     known IP. If someone learns the secret AND the URL, the worst
//     they can do is trigger reminder dispatch out-of-schedule, which
//     a runner would immediately complain about. Reset the secret.
//
// Idempotency: the scheduler's window logic + the 15-min cadence means
// a given athlete's reminder fires at most once per day. If cron
// double-fires (e.g. Railway retry), an athlete may get TWO reminders
// the same morning. Acceptable for v1.1; an idempotency table is V8.1.

import { Hono } from "hono";
import { runReminderScheduler } from "../services/reminders/scheduler.js";

export const cronReminders = new Hono();

cronReminders.get("/reminders", async (c) => {
  const secret = process.env.CRON_SECRET;
  const provided = c.req.header("X-Cron-Secret");
  if (!secret) {
    // CRON_SECRET not configured — refuse to run rather than serve
    // unauthenticated cron traffic. Surfaces in deploy logs as a 503.
    return c.text("not configured", 503);
  }
  if (!provided || !timingSafeEqualString(provided, secret)) {
    return c.text("forbidden", 403);
  }

  try {
    const stats = await runReminderScheduler({ now: new Date() });
    return c.json({ ok: true, ...stats });
  } catch (err) {
    console.error("cron reminders failed:", (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// Constant-time string compare. Defends against timing-leak guesses
// of CRON_SECRET via repeated probes from a network-adjacent attacker.
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
