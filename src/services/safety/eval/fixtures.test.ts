import { describe, expect, test } from "bun:test";
import {
  ALL_MUST_CATCH,
  CONTROL_FIXTURES,
  EMERGENCY_FIXTURES,
  REFERRAL_FIXTURES,
} from "./fixtures.js";

// Structural checks only — the live recall eval (which calls the model)
// runs via `bun run eval:safety`, not in the default suite.
describe("safety eval fixtures (S5)", () => {
  test("has ~30 must-catch fixtures across emergency + referral", () => {
    expect(ALL_MUST_CATCH.length).toBeGreaterThanOrEqual(25);
    expect(EMERGENCY_FIXTURES.length).toBeGreaterThanOrEqual(8);
    expect(REFERRAL_FIXTURES.length).toBeGreaterThanOrEqual(10);
  });

  test("every emergency fixture requires the emergency tier", () => {
    for (const f of EMERGENCY_FIXTURES) expect(f.min).toBe("emergency");
  });

  test("every referral fixture requires at least referral", () => {
    for (const f of REFERRAL_FIXTURES) expect(f.min).toBe("referral");
  });

  test("fixture names are unique and messages non-empty", () => {
    const names = [...ALL_MUST_CATCH, ...CONTROL_FIXTURES].map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    for (const f of [...ALL_MUST_CATCH, ...CONTROL_FIXTURES]) {
      expect(f.message.trim().length).toBeGreaterThan(0);
    }
  });
});
