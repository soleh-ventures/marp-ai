#!/usr/bin/env bun
/**
 * SMOKE TEST UTILITY — set up a test athlete so the reminder scheduler
 * fires on the next dispatch. NOT for production data flows.
 *
 * What it does (idempotent on phone):
 *   - Finds the active athlete for the given phone, or creates one
 *     (consent granted so the scheduler treats it as real).
 *   - Sets timezone (arg or inferred from phone country code).
 *   - Sets reminder_prefs = { enabled: true, time_local: <now, local> }
 *     so the current 15-min window matches immediately.
 *   - Stores a 1-week plan with a non-rest session on TODAY's local
 *     weekday (so findTodaysSession returns something to send).
 *
 * Usage:
 *   railway run -- bun run src/scripts/smoke-reminder.ts <e164-phone> [IANA-tz]
 *   # then dispatch:
 *   railway run -- bun run reminders:run
 *
 * Cleanup afterwards:
 *   railway run -- bun run src/scripts/smoke-reminder.ts <phone> --cleanup
 */

import { and, eq, isNull } from "drizzle-orm";
import { db, sqlClient } from "../db/client.js";
import { athletes } from "../db/schema.js";
import { getAthleticHistory } from "../flows/onboarding.js";
import { inferTimezoneFromPhone } from "../services/reminders/timezone.js";
import type { DayOfWeek, Plan } from "../services/plan/types.js";

function localParts(tz: string, now: Date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time_local: `${hour.padStart(2, "0")}:${get("minute")}`,
    weekday: get("weekday").toLowerCase() as DayOfWeek,
  };
}

function buildTodayPlan(startDate: string, today: DayOfWeek): Plan {
  const allDays: DayOfWeek[] = [
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  ];
  return {
    version: 1,
    source: "generated",
    start_date: startDate,
    race_name: "Smoke Test 10K",
    generated_at: new Date().toISOString(),
    weeks: [
      {
        index: 1,
        phase: "base",
        total_km: 20,
        focus: "smoke-test week",
        sessions: allDays.map((d) =>
          d === today
            ? {
                day_of_week: d,
                type: "easy" as const,
                distance_km: 5,
                duration_min: 30,
                description: "Easy 5K — smoke test session",
                reasoning: "Z2 aerobic base, 10%-rule build",
              }
            : { day_of_week: d, type: "rest" as const, description: "Rest." },
        ),
      },
    ],
  };
}

async function main() {
  const phone = process.argv[2];
  if (!phone || !phone.startsWith("+")) {
    console.error("usage: smoke-reminder.ts <e164-phone e.g. +49...> [IANA-tz | --cleanup]");
    process.exit(1);
  }
  const arg3 = process.argv[3];
  const cleanup = arg3 === "--cleanup";

  const [existing] = await db
    .select()
    .from(athletes)
    .where(and(eq(athletes.phone, phone), isNull(athletes.archivedAt)))
    .limit(1);

  if (cleanup) {
    if (!existing) {
      console.log(`no active athlete for ${phone}; nothing to clean.`);
    } else {
      const history = getAthleticHistory(existing.athleticHistory);
      const { plan: _drop, ...rest } = history;
      await db
        .update(athletes)
        .set({ reminderPrefs: { enabled: false }, athleticHistory: rest })
        .where(eq(athletes.id, existing.id));
      console.log(`cleaned: disabled reminders + removed smoke plan for ${phone}`);
    }
    await sqlClient.end({ timeout: 5 });
    return;
  }

  const tz =
    arg3 && arg3 !== "--cleanup" ? arg3 : (inferTimezoneFromPhone(phone) ?? "UTC");
  const now = new Date();
  const lp = localParts(tz, now);
  const plan = buildTodayPlan(lp.date, lp.weekday);
  const reminderPrefs = { enabled: true, time_local: lp.time_local };

  let athleteId: string;
  if (existing) {
    const history = getAthleticHistory(existing.athleticHistory);
    await db
      .update(athletes)
      .set({
        timezone: tz,
        reminderPrefs,
        athleticHistory: { ...history, plan },
      })
      .where(eq(athletes.id, existing.id));
    athleteId = existing.id;
    console.log(`updated existing athlete ${athleteId}`);
  } else {
    const [created] = await db
      .insert(athletes)
      .values({
        phone,
        name: "Smoke Test",
        consentGrantedAt: now,
        timezone: tz,
        reminderPrefs,
        athleticHistory: { plan },
      })
      .returning({ id: athletes.id });
    athleteId = created!.id;
    console.log(`created athlete ${athleteId}`);
  }

  console.log(
    JSON.stringify(
      {
        phone,
        timezone: tz,
        local_now: `${lp.date} ${lp.time_local} (${lp.weekday})`,
        reminder_time_local: reminderPrefs.time_local,
        today_session: "Easy 5K — smoke test session",
      },
      null,
      2,
    ),
  );
  console.log("\nNow run: railway run -- bun run reminders:run");
  await sqlClient.end({ timeout: 5 });
}

main().catch(async (err) => {
  console.error("smoke-reminder failed:", err);
  await sqlClient.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
