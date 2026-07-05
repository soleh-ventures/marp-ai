// Callback (button tap) handling — the eng-amendment tests:
//  - two DISTINCT callback ids for the same open question apply once
//    (pending_choice is the dedup mechanism, NOT claim-on-callback-id)
//  - a tap for an expired/foreign menu gets a toast, never a state write
//  - per-athlete serialization: tap + text arriving together can't lose
//    athleticHistory writes

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { athletes, messages } from "../db/schema.js";
import { telegramWebhook, pendingTelegramWork } from "./telegram.js";
import { enqueueForAthlete } from "../services/messaging/serialize.js";

const realFetch = globalThis.fetch;
let telegramCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`
    TRUNCATE TABLE
      llm_calls, processed_messages, messages, active_flags,
      activities, race_blocks, strava_connections,
      pending_decisions, safety_events, athletes
    RESTART IDENTITY CASCADE
  `);
  telegramCalls = [];
  // Stub the Telegram Bot API (answerCallbackQuery / editMessageReplyMarkup /
  // sendMessage). Everything else passes through to the real fetch.
  process.env.TELEGRAM_BOT_TOKEN_TEST_STUB = "1";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.telegram.org")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      telegramCalls.push({ url, body });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 4242 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return realFetch(input as never, init as never);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function insertAthlete(overrides?: Record<string, unknown>) {
  const [a] = await db
    .insert(athletes)
    .values({
      phone: "+15550001111",
      telegramChatId: "777001",
      consentGrantedAt: new Date(),
      lastSeenAt: new Date(),
      athleticHistory: {
        onboarding: {
          status: "complete",
          current_section: "complete",
          started_at: new Date().toISOString(),
          turn_count: 3,
        },
        prefs_state: "coach",
        pending_choice: {
          question_id: "coach",
          tg_message_id: "999",
          asked_at: new Date().toISOString(),
        },
        ...overrides,
      },
    })
    .returning();
  if (!a) throw new Error("insert failed");
  return a;
}

function callbackUpdate(cbId: string, data: string, chatId = 777001) {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    callback_query: {
      id: cbId,
      data,
      message: { message_id: 999, chat: { id: chatId } },
    },
  };
}

async function post(update: unknown): Promise<Response> {
  return telegramWebhook.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });
}

describe("callback taps — pending_choice dedup", () => {
  test("two DISTINCT callback ids on the same question apply exactly once", async () => {
    const a = await insertAthlete();

    // Two physical taps = two fresh callback ids, same question.
    const r1 = await post(callbackUpdate("cb-first-tap", "v1:coach:director"));
    const r2 = await post(callbackUpdate("cb-second-tap", "v1:coach:partner"));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    await pendingTelegramWork();

    // Exactly ONE inbound message row landed (the first tap); the second tap
    // hit the stale-toast path and wrote nothing.
    const inbound = await db
      .select({ body: messages.body })
      .from(messages)
      .where(eq(messages.athleteId, a.id));
    const taps = inbound.filter((m) => ["director", "partner"].includes(m.body));
    expect(taps).toHaveLength(1);
    expect(taps[0]!.body).toBe("director");

    // First tap stored the pref; second didn't overwrite it.
    const [row] = await db
      .select({ athleticHistory: athletes.athleticHistory })
      .from(athletes)
      .where(eq(athletes.id, a.id));
    const history = row!.athleticHistory as Record<string, unknown>;
    const prefs = history.coach_prefs as Record<string, unknown>;
    expect(prefs.coaching_style).toBe("director");
    expect(history.pending_choice).toBeUndefined();

    // The second tap answered with the stale toast.
    const answers = telegramCalls.filter((c) => c.url.includes("answerCallbackQuery"));
    const stale = answers.find((c) => String(c.body.text ?? "").includes("Already answered"));
    expect(stale).toBeDefined();
  });

  test("Telegram REDELIVERY of the same callback id is a silent no-op", async () => {
    const a = await insertAthlete();
    await post(callbackUpdate("cb-same-id", "v1:coach:companion"));
    await post(callbackUpdate("cb-same-id", "v1:coach:companion"));
    await pendingTelegramWork();
    const inbound = await db
      .select({ body: messages.body })
      .from(messages)
      .where(eq(messages.athleteId, a.id));
    expect(inbound.filter((m) => m.body === "companion")).toHaveLength(1);
  });

  test("unknown callback version → expired toast, zero writes", async () => {
    const a = await insertAthlete();
    await post(callbackUpdate("cb-old", "v0:coach:director"));
    await pendingTelegramWork();
    const inbound = await db
      .select()
      .from(messages)
      .where(eq(messages.athleteId, a.id));
    expect(inbound).toHaveLength(0);
    const toast = telegramCalls.find(
      (c) =>
        c.url.includes("answerCallbackQuery") &&
        String(c.body.text ?? "").includes("expired"),
    );
    expect(toast).toBeDefined();
  });

  test("tap for a question that is no longer pending → stale toast, no write", async () => {
    const a = await insertAthlete({ pending_choice: undefined });
    await post(callbackUpdate("cb-late", "v1:coach:director"));
    await pendingTelegramWork();
    const inbound = await db
      .select()
      .from(messages)
      .where(eq(messages.athleteId, a.id));
    expect(inbound).toHaveLength(0);
    const [row] = await db
      .select({ athleticHistory: athletes.athleticHistory })
      .from(athletes)
      .where(eq(athletes.id, a.id));
    expect((row!.athleticHistory as Record<string, unknown>).coach_prefs).toBeUndefined();
  });

  test("answered tap retires the keyboard (editMessageReplyMarkup fires)", async () => {
    await insertAthlete();
    await post(callbackUpdate("cb-edit", "v1:coach:partner"));
    await pendingTelegramWork();
    const edit = telegramCalls.find((c) => c.url.includes("editMessageReplyMarkup"));
    expect(edit).toBeDefined();
    expect(edit!.body.message_id).toBe(999);
  });

  // Regression: a tap on a pending_choice-GATED question (calib/caloffer/
  // gcaldis) must still route after the webhook clears pending_choice. The
  // webhook passes answeredChoiceId so the branch matches. Before the fix the
  // branch read the (already-cleared) pending_choice and fell through to the
  // LLM router — the "Set my style / Later loads forever" bug.
  test("gated tap (calib 'Set my style') routes even though the webhook cleared pending_choice", async () => {
    const a = await insertAthlete({
      prefs_state: undefined,
      pending_choice: {
        question_id: "calib",
        tg_message_id: "999",
        asked_at: new Date().toISOString(),
      },
      coach_prefs_offer_at: new Date().toISOString(),
    });
    await post(callbackUpdate("cb-calib", "v1:calib:set_style"));
    await pendingTelegramWork();
    const [row] = await db
      .select({ athleticHistory: athletes.athleticHistory })
      .from(athletes)
      .where(eq(athletes.id, a.id));
    const history = row!.athleticHistory as Record<string, unknown>;
    // The calib branch fired: it moved the athlete into the coach question.
    // (Set BEFORE the reply send, so it survives the test's WhatsApp-routed
    // reply that can't deliver.)
    expect(history.prefs_state).toBe("coach");
    expect(history.pending_choice).toBeUndefined();
  });
});

describe("per-athlete serialization", () => {
  test("concurrent tasks for one athlete run strictly in order", async () => {
    const order: number[] = [];
    const slow = enqueueForAthlete("ath-1", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });
    const fast = enqueueForAthlete("ath-1", async () => {
      order.push(2);
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual([1, 2]);
  });

  test("a failing task never wedges the athlete's queue", async () => {
    const results: string[] = [];
    const bad = enqueueForAthlete("ath-2", async () => {
      throw new Error("boom");
    }).catch(() => results.push("failed"));
    const good = enqueueForAthlete("ath-2", async () => {
      results.push("ran");
    });
    await Promise.all([bad, good]);
    expect(results).toContain("ran");
  });

  test("different athletes are NOT serialized against each other", async () => {
    const order: string[] = [];
    const a = enqueueForAthlete("ath-3", async () => {
      await new Promise((r) => setTimeout(r, 40));
      order.push("slow-athlete");
    });
    const b = enqueueForAthlete("ath-4", async () => {
      order.push("fast-athlete");
    });
    await Promise.all([a, b]);
    expect(order[0]).toBe("fast-athlete");
  });
});
