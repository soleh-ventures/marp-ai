#!/usr/bin/env bun
/**
 * V8/V10 — standalone reminder dispatch for Railway native cron.
 *
 * Railway's native cron runs a COMMAND on a schedule (it does not make
 * HTTP requests). This script is that command: it runs the reminder
 * scheduler once, prints dispatch stats, closes the DB pool, and exits.
 *
 * Railway setup (see README / docs):
 *   - Create a SEPARATE service from the same repo (do NOT put a cron
 *     schedule on the always-on web server — that takes the webhook
 *     listener offline).
 *   - Cron schedule: slash-15 stars (every 15 min)
 *   - Start command: bun run src/scripts/run-reminders.ts
 *
 * This shares the exact scheduler used by the HTTP endpoint
 * (/internal/cron/reminders), so behaviour is identical — the endpoint
 * stays available for external HTTP cron services as an alternative.
 *
 * For local / dev:
 *   bun run src/scripts/run-reminders.ts
 *
 * For prod (manual one-off):
 *   railway run -- bun run src/scripts/run-reminders.ts
 */

import { sqlClient } from "../db/client.js";
import { runReminderScheduler } from "../services/reminders/scheduler.js";

async function main(): Promise<void> {
  const startedAt = new Date();
  console.log(`run-reminders: starting at ${startedAt.toISOString()}`);

  const stats = await runReminderScheduler({ now: startedAt });
  console.log(`run-reminders: done ${JSON.stringify(stats)}`);
}

main()
  .then(async () => {
    // Close the pool so the process exits promptly rather than hanging
    // on idle connections (idle_timeout would eventually free them, but
    // a cron run should exit the moment work is done).
    await sqlClient.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("run-reminders: fatal:", (err as Error).message);
    await sqlClient.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
