import { describe, expect, test } from "bun:test";
import {
  ACK_DELAY_MS,
  _thinkingAckMessages,
  pickThinkingAck,
} from "./thinking-ack.js";

describe("ACK_DELAY_MS", () => {
  test("is 5 seconds (T13 spec)", () => {
    expect(ACK_DELAY_MS).toBe(5_000);
  });
});

describe("thinking-ack message set", () => {
  test("has at least 6 distinct phrases (so a runner who triggers two acks in a row gets variety)", () => {
    expect(_thinkingAckMessages.length).toBeGreaterThanOrEqual(6);
    const unique = new Set(_thinkingAckMessages);
    expect(unique.size).toBe(_thinkingAckMessages.length);
  });

  test("every phrase fits comfortably in a WhatsApp message (under 100 chars)", () => {
    for (const msg of _thinkingAckMessages) {
      expect(msg.length).toBeLessThan(100);
    }
  });

  test("no phrase makes a timing promise (no '5 seconds', '1 minute' etc.)", () => {
    // We don't actually know how long the router will take — promising
    // a window we can't keep erodes the trust the ack is meant to build.
    const timingPromisePatterns = [
      /\d+\s*(second|sec\b|minute|min\b)/i,
    ];
    for (const msg of _thinkingAckMessages) {
      for (const re of timingPromisePatterns) {
        expect(msg).not.toMatch(re);
      }
    }
  });

  test("no phrase repeats 'thinking…' verbatim (T13 brief: varied wording, runner-flavoured)", () => {
    // 'Think' as a verb is fine ("let me think this through"); a bare
    // "Thinking…" or "Thinking about it…" is the bot-status placeholder
    // the brief was written to avoid.
    for (const msg of _thinkingAckMessages) {
      expect(msg.toLowerCase()).not.toMatch(/^thinking\b/);
      expect(msg.toLowerCase()).not.toMatch(/\bthinking\.\.\.|thinking…/);
    }
  });

  test("phrases are warm / conversational — none start with 'Please wait' or 'Processing'", () => {
    for (const msg of _thinkingAckMessages) {
      expect(msg.toLowerCase()).not.toMatch(/^please wait/);
      expect(msg.toLowerCase()).not.toMatch(/^processing/);
    }
  });
});

describe("pickThinkingAck", () => {
  test("always returns a phrase from the canned set", () => {
    // Sample a handful of pulls; with random rng we just want to know
    // it never returns garbage.
    for (let i = 0; i < 20; i++) {
      const picked = pickThinkingAck();
      expect(_thinkingAckMessages).toContain(picked);
    }
  });

  test("picks deterministically when a fixed rng is supplied (for tests)", () => {
    const first = _thinkingAckMessages[0]!;
    expect(pickThinkingAck(() => 0)).toBe(first);
    const last = _thinkingAckMessages[_thinkingAckMessages.length - 1]!;
    expect(pickThinkingAck(() => 0.9999)).toBe(last);
  });

  test("returns a non-empty string", () => {
    expect(pickThinkingAck().length).toBeGreaterThan(0);
  });
});
