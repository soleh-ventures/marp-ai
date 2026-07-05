// Preference flow — deterministic state machine tests (no LLM: every path
// here is tap/typed-answer driven; extraction paths have their own fallbacks).

import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { athletes } from "../db/schema.js";
import { getAthleticHistory } from "./onboarding.js";
import {
  Q_COACH,
  Q_HOLISTIC,
  Q_MIRROR,
  Q_REPLY,
  Q_TRAINING,
  Q_TRAINING_CONFIRM,
  buildReask,
  getCoachPrefs,
  getPrefsState,
  handlePrefsTurn,
  renderHolisticReflection,
  renderMirrorCard,
  startPrefsFlow,
} from "./preferences.js";

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`
    TRUNCATE TABLE
      llm_calls, processed_messages, messages, active_flags,
      activities, race_blocks, strava_connections,
      pending_decisions, athletes
    RESTART IDENTITY CASCADE
  `);
});

const PROFILE = {
  name: "Kemal",
  target_race: { name: "Berlin Half", date: "2026-09-21", goal_time: "1:45:00" },
  current_mileage_km_per_week: 32,
  longest_recent_run_km: 14,
  training_days_per_week: 4,
  preferred_time: "evening",
  current_injuries: ["left knee — occasional"],
  city: "Berlin",
  onboarding: {
    status: "complete",
    current_section: "complete",
    started_at: new Date().toISOString(),
    turn_count: 3,
  },
};

async function insertAthlete(history: Record<string, unknown>) {
  const [a] = await db
    .insert(athletes)
    .values({
      phone: "+15550002222",
      consentGrantedAt: new Date(),
      athleticHistory: history,
    })
    .returning();
  if (!a) throw new Error("insert failed");
  return a;
}

async function historyOf(athleteId: string) {
  const [row] = await db
    .select({ athleticHistory: athletes.athleticHistory })
    .from(athletes)
    .where(eq(athletes.id, athleteId));
  return getAthleticHistory(row!.athleticHistory);
}

describe("mirror card", () => {
  test("renders only lines with data, ends with a confirm question", () => {
    const card = renderMirrorCard(PROFILE as never);
    expect(card).toContain("Berlin Half");
    expect(card).toContain("target 1:45:00");
    expect(card).toContain("~32 km/week");
    expect(card).toContain("4 days/week");
    expect(card).toContain("left knee");
    expect(card).toContain("📍 Berlin");
    expect(card).toContain("Anything wrong?");
  });

  test("empty profile still renders a valid card", () => {
    const card = renderMirrorCard({} as never);
    expect(card).toContain("Here's what I've got");
    expect(card).toContain("get fitter");
  });
});

describe("happy path — taps only", () => {
  test("mirror ✓ → coach → persona flips ON → reply → training → holistic skip", async () => {
    const a = await insertAthlete(PROFILE);
    const started = await startPrefsFlow(a.id, await historyOf(a.id));
    expect(started.choices.id).toBe(Q_MIRROR.id);
    expect(getPrefsState(await historyOf(a.id))).toBe("mirror");

    // ✓ All correct → coaching-style question
    let r = await handlePrefsTurn({
      athleteId: a.id, messageId: "m1", body: "confirm",
      history: await historyOf(a.id),
    });
    expect(r.kind).toBe("handled");
    if (r.kind !== "handled") throw new Error("unreachable");
    expect(r.reply).toContain("How should I coach you?");
    expect(r.choices?.id).toBe(Q_COACH.id);

    // Tap Director → persona opener leads THE VERY NEXT message
    r = await handlePrefsTurn({
      athleteId: a.id, messageId: "m2", body: "director",
      history: await historyOf(a.id),
    });
    if (r.kind !== "handled") throw new Error("expected handled");
    expect(r.reply.startsWith("Good. I call it, you run it.")).toBe(true);
    expect(r.choices?.id).toBe(Q_REPLY.id);
    expect(getCoachPrefs(await historyOf(a.id)).coaching_style).toBe("director");

    // Reply length: short
    r = await handlePrefsTurn({
      athleteId: a.id, messageId: "m3", body: "short",
      history: await historyOf(a.id),
    });
    if (r.kind !== "handled") throw new Error("expected handled");
    expect(r.choices?.id).toBe(Q_TRAINING.id);
    expect(getCoachPrefs(await historyOf(a.id)).reply_style).toBe("short");

    // Training: hard (no confirm needed)
    r = await handlePrefsTurn({
      athleteId: a.id, messageId: "m4", body: "hard",
      history: await historyOf(a.id),
    });
    if (r.kind !== "handled") throw new Error("expected handled");
    expect(r.choices?.id).toBe(Q_HOLISTIC.id);
    expect(getCoachPrefs(await historyOf(a.id)).training_style).toBe("hard");

    // Holistic: skip → pivotReady
    r = await handlePrefsTurn({
      athleteId: a.id, messageId: "m5", body: "skip",
      history: await historyOf(a.id),
    });
    if (r.kind !== "handled") throw new Error("expected handled");
    expect(r.pivotReady).toBe(true);
    expect(getPrefsState(await historyOf(a.id))).toBe("done");
  });
});

describe("aggressive requires an explicit confirm", () => {
  test("aggressive → warning; 'Yes — all in' stores aggressive", async () => {
    const a = await insertAthlete({ ...PROFILE, prefs_state: "training" });
    let r = await handlePrefsTurn({
      athleteId: a.id, messageId: "m1", body: "aggressive",
      history: await historyOf(a.id),
    });
    if (r.kind !== "handled") throw new Error("expected handled");
    expect(r.reply).toContain("Injuries end seasons");
    expect(r.choices?.id).toBe(Q_TRAINING_CONFIRM.id);
    expect(getCoachPrefs(await historyOf(a.id)).training_style).toBeUndefined();

    r = await handlePrefsTurn({
      athleteId: a.id, messageId: "m2", body: "aggressive_yes",
      history: await historyOf(a.id),
    });
    if (r.kind !== "handled") throw new Error("expected handled");
    expect(getCoachPrefs(await historyOf(a.id)).training_style).toBe("aggressive");
  });

  test("'Go Hard instead' backs off to hard", async () => {
    const a = await insertAthlete({ ...PROFILE, prefs_state: "training_confirm" });
    const r = await handlePrefsTurn({
      athleteId: a.id, messageId: "m1", body: "go_hard",
      history: await historyOf(a.id),
    });
    if (r.kind !== "handled") throw new Error("expected handled");
    expect(getCoachPrefs(await historyOf(a.id)).training_style).toBe("hard");
  });
});

describe("'You decide, coach' — spoken defaults, never silent", () => {
  test("delegate on coaching style speaks the default and records delegation", async () => {
    const a = await insertAthlete({ ...PROFILE, prefs_state: "coach" });
    const r = await handlePrefsTurn({
      athleteId: a.id, messageId: "m1", body: "delegate",
      history: await historyOf(a.id),
    });
    if (r.kind !== "handled") throw new Error("expected handled");
    expect(r.reply).toContain("I'll start as your Partner");
    const prefs = getCoachPrefs(await historyOf(a.id));
    expect(prefs.coaching_style).toBe("partner");
    expect(prefs.delegated).toContain("coaching_style");
  });
});

describe("interruption → re-ask once → spoken default", () => {
  test("unrelated question mid-coach-question interrupts, then re-asks, then defaults", async () => {
    const a = await insertAthlete({ ...PROFILE, prefs_state: "coach" });
    // A real question is not an answer.
    const r = await handlePrefsTurn({
      athleteId: a.id, messageId: "m1",
      body: "what pace should my easy runs be at these days?",
      history: await historyOf(a.id),
    });
    expect(r.kind).toBe("interrupt");

    // First miss → re-ask with the same question attached.
    const reask1 = await buildReask(a.id, await historyOf(a.id));
    expect(reask1.append).toContain("How should I coach you?");
    expect(reask1.choices?.id).toBe(Q_COACH.id);

    // Second miss → SPOKEN default, advance to the next question.
    const reask2 = await buildReask(a.id, await historyOf(a.id));
    expect(reask2.append).toContain("I'll start as your Partner");
    expect(reask2.choices?.id).toBe(Q_REPLY.id);
    const prefs = getCoachPrefs(await historyOf(a.id));
    expect(prefs.coaching_style).toBe("partner");
    expect(getPrefsState(await historyOf(a.id))).toBe("reply");
  });
});

describe("holistic reflection", () => {
  test("mirrors sports, load, sleep, and topics back", () => {
    const text = renderHolisticReflection({
      other_sports: [{ sport: "football", frequency_per_week: 1 }],
      life_context: { work: "desk job", family: "2 kids", sleep: "rough" },
      coach_topics: ["nutrition", "sleep"],
    });
    expect(text).toContain("football");
    expect(text).toContain("recovery is the real constraint");
    expect(text).toContain("nutrition, sleep");
  });

  test("empty extraction still lands a beat", () => {
    expect(renderHolisticReflection({})).toBe("Noted.");
  });
});
