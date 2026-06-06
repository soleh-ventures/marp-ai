import { describe, expect, test } from "bun:test";
import { parseTriage } from "./triage.js";

describe("parseTriage (S1)", () => {
  test("parses an emergency", () => {
    const t = parseTriage('{"tier":"emergency","category":"cardiac","reason":"chest pain"}');
    expect(t.tier).toBe("emergency");
    expect(t.category).toBe("cardiac");
  });

  test("parses a referral", () => {
    const t = parseTriage('{"tier":"referral","category":"ed_reds","reason":"restricting"}');
    expect(t.tier).toBe("referral");
    expect(t.category).toBe("ed_reds");
  });

  test("parses none", () => {
    expect(parseTriage('{"tier":"none","category":"none","reason":"taper q"}').tier).toBe("none");
  });

  test("strips markdown fences", () => {
    const t = parseTriage('```json\n{"tier":"referral","category":"pregnancy","reason":"x"}\n```');
    expect(t.tier).toBe("referral");
  });

  test("an unknown tier value falls back to none (parseable but invalid)", () => {
    expect(parseTriage('{"tier":"panic","category":"x","reason":"y"}').tier).toBe("none");
  });

  test("missing fields default safely", () => {
    const t = parseTriage('{"tier":"emergency"}');
    expect(t.tier).toBe("emergency");
    expect(t.category).toBe("none");
    expect(t.reason).toBe("");
  });

  test("throws on non-JSON so the caller can retry", () => {
    expect(() => parseTriage("I am not json")).toThrow();
  });
});
