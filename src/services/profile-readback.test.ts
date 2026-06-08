import { describe, expect, test } from "bun:test";
import { profileQuestionKind } from "./profile-readback.js";

// KER-78 (1d): the pre-check that routes a direct profile question to the
// deterministic readback (no LLM). Must catch the real phrasings and stay
// off ordinary coaching talk.
describe("profileQuestionKind", () => {
  const location = [
    "where do I live?",
    "where am I based",
    "what's my home city",
    "what is my location",
    "which city do I live in",
  ];
  for (const m of location) {
    test(`location: "${m}"`, () => expect(profileQuestionKind(m)).toBe("location"));
  }

  const goal = [
    "what's my goal?",
    "what is my target time",
    "what's my goal time",
    "what am I training for",
    "what's my race goal",
  ];
  for (const m of goal) {
    test(`goal: "${m}"`, () => expect(profileQuestionKind(m)).toBe("goal"));
  }

  const profile = [
    "what do you know about me?",
    "what's on file",
    "what's in my profile",
    "what have you got on me",
  ];
  for (const m of profile) {
    test(`profile: "${m}"`, () => expect(profileQuestionKind(m)).toBe("profile"));
  }

  const notProfile = [
    "how should I taper?",
    "I live for these long runs",
    "what's my pace target for tomorrow's intervals", // coaching, not profile
    "where should I run this weekend",
    "my goal this week is to not skip a session", // aspirational chatter
  ];
  for (const m of notProfile) {
    test(`not a profile question: "${m}"`, () =>
      expect(profileQuestionKind(m)).toBeNull());
  }
});
