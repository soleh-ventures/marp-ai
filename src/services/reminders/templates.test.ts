import { describe, expect, test } from "bun:test";
import { buildReminderText } from "./templates.js";
import type { PlanSession } from "../plan/types.js";

const easy: PlanSession = {
  day_of_week: "tuesday",
  type: "easy",
  distance_km: 6,
  description: "Easy 6K at Z2",
  reasoning: "aerobic base, 10%-rule",
};

describe("buildReminderText (F7 timing)", () => {
  test("morning_of framing: 'Morning' + today's session", () => {
    const t = buildReminderText({ name: "Sam", session: easy });
    expect(t).toContain("Morning Sam");
    expect(t).toContain("today's session");
  });

  test("night_before framing: 'Evening' + tomorrow's session", () => {
    const t = buildReminderText({ name: "Sam", session: easy, nightBefore: true });
    expect(t).toContain("Evening Sam");
    expect(t).toContain("tomorrow's session");
  });

  test("falls back to a name-less greeting when name is 'you'", () => {
    const t = buildReminderText({ name: "you", session: easy, nightBefore: true });
    expect(t).toContain("Evening — ");
  });
});
