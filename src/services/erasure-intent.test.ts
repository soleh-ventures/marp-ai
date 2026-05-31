import { describe, expect, test } from "bun:test";
import {
  isDeletionConfirmation,
  looksLikeDeletionRequest,
} from "./erasure-intent.js";

describe("looksLikeDeletionRequest", () => {
  test.each([
    "delete my account",
    "DELETE MY ACCOUNT",
    "please delete my data",
    "I want to delete my profile",
    "forget me",
    "forget everything about me",
    "remove my account",
    "erase my data",
    "wipe my profile",
    "Delete me",
  ])("matches %s", (input) => {
    expect(looksLikeDeletionRequest(input)).toBe(true);
  });

  test.each([
    "how was my last run?",
    "what's the weather",
    "delete that workout from my plan", // talks about a workout, not the account
    "remove the long run",
    "what should I do next?",
  ])("does NOT match %s", (input) => {
    expect(looksLikeDeletionRequest(input)).toBe(false);
  });
});

describe("isDeletionConfirmation", () => {
  test("matches the canonical phrase", () => {
    expect(isDeletionConfirmation("YES DELETE")).toBe(true);
  });

  test("matches case-insensitively", () => {
    expect(isDeletionConfirmation("yes delete")).toBe(true);
    expect(isDeletionConfirmation("Yes Delete")).toBe(true);
  });

  test("tolerates surrounding whitespace", () => {
    expect(isDeletionConfirmation("  YES DELETE  ")).toBe(true);
    expect(isDeletionConfirmation("\nYES DELETE\n")).toBe(true);
  });

  test("does not match partial / extended phrases", () => {
    expect(isDeletionConfirmation("YES")).toBe(false);
    expect(isDeletionConfirmation("YES DELETE PLEASE")).toBe(false);
    expect(isDeletionConfirmation("YES, DELETE")).toBe(false);
    expect(isDeletionConfirmation("delete yes")).toBe(false);
  });
});
