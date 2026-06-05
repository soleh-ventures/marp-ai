import { describe, expect, test } from "bun:test";
import { THINKING_ACK } from "./thinking-ack.js";

describe("THINKING_ACK", () => {
  test('is the literal "thinking…" — v1.1 collapsed the 8-phrase v1 ack to one signal', () => {
    expect(THINKING_ACK).toBe("thinking…");
  });

  test("fits comfortably in a WhatsApp message (under 100 chars)", () => {
    expect(THINKING_ACK.length).toBeLessThan(100);
  });

  test("makes no timing promise (no '5 seconds', '1 minute' etc.)", () => {
    expect(THINKING_ACK).not.toMatch(/\d+\s*(second|sec\b|minute|min\b)/i);
  });
});
