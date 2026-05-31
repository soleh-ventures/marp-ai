import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { app } from "../server.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { athletes, messages, processedMessages } from "../db/schema.js";
import { _resetProviderCache, mockProvider } from "../services/llm/index.js";
import { computeSignature } from "../services/twilio-signature.js";
import { pendingBackgroundWork } from "./twilio.js";

const TEST_AUTH_TOKEN = "test_auth_token_DO_NOT_USE_IN_PROD";
const WEBHOOK_URL = "https://marp.test/webhooks/twilio/whatsapp";

beforeAll(() => {
  // Force the handler to use a known auth token for signature math.
  // The test runs against the real Postgres dev DB.
  (config.twilio as { authToken: string }).authToken = TEST_AUTH_TOKEN;
  (config.twilio as { publicWebhookBase: string }).publicWebhookBase =
    "https://marp.test";
  (config.twilio as { skipSignature: boolean }).skipSignature = false;
  // Force the LLM into mock mode so the webhook's background
  // processIncoming doesn't try to call Anthropic.
  (config.llm as { provider: "mock" | "anthropic" }).provider = "mock";
  _resetProviderCache();
  // Blank account SID short-circuits sendWhatsApp before any HTTP call —
  // tests don't need real outbound delivery and we don't want to hammer
  // Twilio with bad creds (slow + 401 noise in test output).
  (config.twilio as { accountSid: string }).accountSid = "";
});

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`
    TRUNCATE TABLE
      llm_calls, processed_messages, messages, active_flags,
      activities, race_blocks, athletes
    RESTART IDENTITY CASCADE
  `);
  // Catch-all canned responses so the background processIncoming runs
  // cleanly. These tests don't assert on the reply content — they
  // assert on the webhook ingress contract — so any valid response
  // shape is fine. Ordered most-specific-first.
  mockProvider.reset();
  mockProvider.setResponses([
    { match: "# Expert answers", text: "synthesized-stub-reply" },
    { match: "# Message", text: "domain-stub-reply" },
    {
      match: /.*/,
      text: '{"domains":["training"],"confidence":0.5,"rationale":"stub"}',
    },
  ]);
});

afterEach(async () => {
  // Drain any fire-and-forget processIncoming work the webhook kicked
  // off — otherwise the next beforeEach TRUNCATE races the background
  // insert into llm_calls and we get FK violations.
  await pendingBackgroundWork();
});

function makeSignedRequest(params: Record<string, string>): Request {
  const sig = computeSignature(TEST_AUTH_TOKEN, WEBHOOK_URL, params);
  const body = new URLSearchParams(params).toString();
  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "X-Twilio-Signature": sig,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

describe("POST /webhooks/twilio/whatsapp", () => {
  test("rejects unsigned requests with 403", async () => {
    const body = new URLSearchParams({
      MessageSid: "SM_unsigned_001",
      From: "whatsapp:+15551234567",
      Body: "hi",
    }).toString();
    const res = await app.fetch(
      new Request(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
    );
    expect(res.status).toBe(403);
  });

  test("rejects requests with a wrong signature", async () => {
    const body = new URLSearchParams({
      MessageSid: "SM_badsig_001",
      From: "whatsapp:+15551234567",
      Body: "hi",
    }).toString();
    const res = await app.fetch(
      new Request(WEBHOOK_URL, {
        method: "POST",
        headers: {
          "X-Twilio-Signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      }),
    );
    expect(res.status).toBe(403);
  });

  test("rejects requests missing MessageSid", async () => {
    const res = await app.fetch(
      makeSignedRequest({ From: "whatsapp:+15551234567", Body: "hi" }),
    );
    expect(res.status).toBe(400);
  });

  test("accepts a valid request, creates athlete + message", async () => {
    const res = await app.fetch(
      makeSignedRequest({
        MessageSid: "SM_happy_001",
        From: "whatsapp:+15551234567",
        Body: "knee feels weird, should i run?",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");

    const athleteRows = await db.select().from(athletes);
    expect(athleteRows).toHaveLength(1);
    expect(athleteRows[0]?.phone).toBe("+15551234567");

    const msgRows = await db.select().from(messages);
    expect(msgRows).toHaveLength(1);
    expect(msgRows[0]?.body).toBe("knee feels weird, should i run?");
    expect(msgRows[0]?.direction).toBe("in");
    expect(msgRows[0]?.twilioMessageSid).toBe("SM_happy_001");

    const processed = await db.select().from(processedMessages);
    expect(processed).toHaveLength(1);
    expect(processed[0]?.twilioMessageSid).toBe("SM_happy_001");
  });

  test("idempotent: duplicate delivery of same MessageSid persists message exactly once", async () => {
    const req = () =>
      makeSignedRequest({
        MessageSid: "SM_dup_001",
        From: "whatsapp:+15551234567",
        Body: "first",
      });

    const r1 = await app.fetch(req());
    expect(r1.status).toBe(200);
    const r2 = await app.fetch(req());
    expect(r2.status).toBe(200);
    const r3 = await app.fetch(req());
    expect(r3.status).toBe(200);

    const msgRows = await db.select().from(messages);
    expect(msgRows).toHaveLength(1);
    const processed = await db.select().from(processedMessages);
    expect(processed).toHaveLength(1);
  });

  test("captures media URL when NumMedia > 0", async () => {
    const res = await app.fetch(
      makeSignedRequest({
        MessageSid: "SM_media_001",
        From: "whatsapp:+15551234567",
        Body: "",
        NumMedia: "1",
        MediaUrl0: "https://twilio.example/media/abc123.fit",
        MediaContentType0: "application/octet-stream",
      }),
    );
    expect(res.status).toBe(200);

    const msgRows = await db.select().from(messages);
    expect(msgRows[0]?.mediaUrl).toBe("https://twilio.example/media/abc123.fit");
  });

  test("returns 200 with empty TwiML envelope on duplicate", async () => {
    const params = {
      MessageSid: "SM_envelope_001",
      From: "whatsapp:+15551234567",
      Body: "test",
    };
    await app.fetch(makeSignedRequest(params));
    const res2 = await app.fetch(makeSignedRequest(params));
    const text = await res2.text();
    expect(text).toContain("<Response></Response>");
  });
});
