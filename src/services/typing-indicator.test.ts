import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../config.js";
import { sendTypingIndicator } from "./twilio-send.js";
import { fireTypingIndicator } from "./typing-indicator.js";

// Snapshot + restore the real fetch and creds so these tests don't leak.
const realFetch = globalThis.fetch;
const realSid = config.twilio.accountSid;
const realToken = config.twilio.authToken;

type Cfg = { accountSid: string; authToken: string };
function setCreds(sid: string, token: string) {
  (config.twilio as Cfg).accountSid = sid;
  (config.twilio as Cfg).authToken = token;
}

beforeEach(() => setCreds("AC_test", "tok_test"));
afterEach(() => {
  globalThis.fetch = realFetch;
  setCreds(realSid, realToken);
});

describe("sendTypingIndicator", () => {
  test("POSTs the inbound SID + channel=whatsapp to the Typing endpoint", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    let capturedAuth = "";
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = String(init.body);
      capturedAuth = String((init.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await sendTypingIndicator("SM123abc");
    expect(ok).toBe(true);
    expect(capturedUrl).toBe(
      "https://messaging.twilio.com/v2/Indicators/Typing.json",
    );
    const parsed = new URLSearchParams(capturedBody);
    expect(parsed.get("messageId")).toBe("SM123abc");
    expect(parsed.get("channel")).toBe("whatsapp");
    expect(capturedAuth.startsWith("Basic ")).toBe(true);
  });

  test("returns false (no throw) on a non-2xx Twilio response", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 400 })) as unknown as typeof fetch;
    expect(await sendTypingIndicator("SM123")).toBe(false);
  });

  test("returns false (no throw) when fetch itself throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await sendTypingIndicator("SM123")).toBe(false);
  });

  test("returns false without calling fetch when creds are missing", async () => {
    setCreds("", "");
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await sendTypingIndicator("SM123")).toBe(false);
    expect(called).toBe(false);
  });

  test("returns false without calling fetch when the inbound SID is empty", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await sendTypingIndicator("")).toBe(false);
    expect(called).toBe(false);
  });
});

describe("fireTypingIndicator (fire-and-forget)", () => {
  test("no-ops on a missing inbound SID — never calls fetch", () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    fireTypingIndicator(null);
    fireTypingIndicator(undefined);
    fireTypingIndicator("");
    expect(called).toBe(false);
  });
});
