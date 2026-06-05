import { describe, expect, test } from "bun:test";
import { looksLikeTimezoneChange } from "./timezone-override.js";

// The pre-filter is the cost gate: it decides whether we pay for a Haiku
// extraction at all. It should fire on real location announcements and
// stay quiet on ordinary chat — false positives cost one null Haiku call,
// false negatives silently ignore the runner's correction.
describe("looksLikeTimezoneChange", () => {
  const positives = [
    "I live in NYC actually",
    "I'm in Tokyo this week",
    "i am in london right now",
    "I moved to Berlin last month",
    "just relocated to Singapore",
    "I'm based in Sydney",
    "currently in Bali",
    "can you change my timezone to Paris",
    "set timezone to America/Chicago",
    "flying to Dubai tomorrow",
  ];
  for (const msg of positives) {
    test(`fires on: "${msg}"`, () => {
      expect(looksLikeTimezoneChange(msg)).toBe(true);
    });
  }

  const negatives = [
    "I'm in pain after that long run",
    "how many km should I do this week?",
    "thanks, that was helpful",
    "my knee hurts",
    "what's my plan for tomorrow",
  ];
  for (const msg of negatives) {
    test(`stays quiet on: "${msg}"`, () => {
      expect(looksLikeTimezoneChange(msg)).toBe(false);
    });
  }
});
