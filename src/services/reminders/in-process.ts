// V8 deploy adaptation — in-process reminder scheduler.
//
// Railway runs marp-ai as a single always-on web service (it must be —
// it's the Twilio webhook listener). Rather than stand up a second
// service or external HTTP cron, we tick the reminder scheduler from
// inside the running server on a 15-minute interval.
//
// Why this is correct for our deployment:
//   - One replica → no double-firing across instances.
//   - Interval == scheduler WINDOW_MINUTES (15) → consecutive windows
//     tile with no gap/overlap, so each athlete's local reminder time
//     lands in exactly one window per day.
//   - A server restart re-phases the interval, but the window logic
//     still tiles correctly; worst case is the documented v1.1 caveat
//     (a restart straddling a window could miss/double a single day).
//
// Guards:
//   - Overlap guard: if a tick is still running when the next fires
//     (shouldn't happen — a tick is sub-second), the new tick is
//     skipped rather than running concurrently.
//   - Errors are logged, never thrown — a failed tick must not crash
//     the web server.

import { config } from "../../config.js";
import { runReminderScheduler } from "./scheduler.js";
import { runWeeklyEvaluationSweep } from "../weekly-evaluation.js";
import { runOnboardingNudges } from "../onboarding-nudge.js";

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) {
    console.warn("reminder tick skipped — previous tick still running");
    return;
  }
  running = true;
  try {
    const stats = await runReminderScheduler({ now: new Date() });
    // Only log when something happened — avoids 96 noise lines/day.
    if (stats.sent > 0 || stats.failed > 0) {
      console.log(`reminder tick: ${JSON.stringify(stats)}`);
    }
  } catch (err) {
    console.error("reminder tick failed:", (err as Error).message);
  }
  // KER-79 (Phase 2): end-of-week coach evaluation rides the same tick.
  // Supersedes M1's weekly retro-proposal (which only spoke up to propose a
  // change); the evaluation always gives the runner their week's read and,
  // when warranted, applies the adjustment itself. Idempotent per athlete-
  // week. The event-driven retro (maybeEventRetro, on a strong post-run
  // signal) is unchanged and still fires from the ingest path.
  try {
    const evalSweep = await runWeeklyEvaluationSweep({ now: new Date() });
    if (evalSweep.ran > 0) {
      console.log(`weekly evaluation: ${JSON.stringify(evalSweep)}`);
    }
  } catch (err) {
    console.error("weekly evaluation sweep failed:", (err as Error).message);
  }
  // Onboarding revamp: one gentle nudge for athletes who went silent
  // mid-preference-phase (>24h), at most once per athlete ever.
  try {
    const nudged = await runOnboardingNudges(new Date());
    if (nudged > 0) console.log(`onboarding nudges sent: ${nudged}`);
  } catch (err) {
    console.error("onboarding nudge sweep failed:", (err as Error).message);
  } finally {
    running = false;
  }
}

// Starts the interval timer. Idempotent — calling twice is a no-op.
// Returns true if started, false if disabled by config or already on.
export function startReminderScheduler(): boolean {
  if (!config.reminders.inProcess) {
    console.log("reminder scheduler: disabled (set REMINDER_SCHEDULER=on to enable)");
    return false;
  }
  if (timer) return false;
  timer = setInterval(() => {
    void tick();
  }, config.reminders.intervalMs);
  // Don't keep the event loop alive solely for this timer — lets the
  // process exit cleanly on shutdown signals.
  if (typeof timer.unref === "function") timer.unref();
  console.log(
    `reminder scheduler: started, ticking every ${config.reminders.intervalMs / 60000} min`,
  );
  return true;
}

// Stops the timer. Used by tests; prod runs for the process lifetime.
export function stopReminderScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
