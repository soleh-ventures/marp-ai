import { afterEach, describe, expect, test } from "bun:test";
import { startReminderScheduler, stopReminderScheduler } from "./in-process.js";

// These tests exercise the gating + lifecycle only. The actual dispatch
// logic is covered by scheduler.test.ts; we mustn't fire real ticks here
// (they'd hit the DB), so we rely on the 15-min interval never elapsing
// within the test and on the config flag to gate startup.

const ORIGINAL = process.env.REMINDER_SCHEDULER;

afterEach(() => {
  stopReminderScheduler();
  if (ORIGINAL === undefined) delete process.env.REMINDER_SCHEDULER;
  else process.env.REMINDER_SCHEDULER = ORIGINAL;
});

describe("startReminderScheduler", () => {
  test("is a no-op when disabled (non-prod, flag unset)", () => {
    delete process.env.REMINDER_SCHEDULER;
    // config.reminders.inProcess is evaluated at import time from NODE_env;
    // in the test env (not prod, flag unset) it resolves to false.
    const started = startReminderScheduler();
    expect(started).toBe(false);
  });
});
