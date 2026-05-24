import { describe, expect, test } from "bun:test";
import { parseRouting } from "./classifier.js";

describe("parseRouting", () => {
  test("happy path: clean JSON", () => {
    const r = parseRouting(
      '{"domains":["training"],"confidence":0.92,"rationale":"asks about taper"}',
    );
    expect(r.domains).toEqual(["training"]);
    expect(r.confidence).toBeCloseTo(0.92);
    expect(r.rationale).toBe("asks about taper");
  });

  test("strips markdown fences", () => {
    const r = parseRouting(
      '```json\n{"domains":["injury","mental"],"confidence":0.7,"rationale":"shin pain + race nerves"}\n```',
    );
    expect(r.domains).toEqual(["injury", "mental"]);
  });

  test("de-dupes repeated domains", () => {
    const r = parseRouting(
      '{"domains":["training","training","injury"],"confidence":0.5,"rationale":""}',
    );
    expect(r.domains).toEqual(["training", "injury"]);
  });

  test("filters unknown domains", () => {
    const r = parseRouting(
      '{"domains":["training","tarot","injury"],"confidence":0.5,"rationale":""}',
    );
    expect(r.domains).toEqual(["training", "injury"]);
  });

  test("throws on non-JSON", () => {
    expect(() => parseRouting("I think this is about training")).toThrow();
  });

  test("throws on empty domains list", () => {
    expect(() =>
      parseRouting('{"domains":[],"confidence":0.1,"rationale":"unsure"}'),
    ).toThrow();
  });

  test("throws when no domains are recognised", () => {
    expect(() =>
      parseRouting('{"domains":["tarot","astrology"],"confidence":0.9}'),
    ).toThrow();
  });

  test("tolerates prose wrapping the JSON", () => {
    const r = parseRouting(
      'Sure — here is the routing:\n{"domains":["nutrition"],"confidence":0.8,"rationale":"asks about gels"}\nLet me know if you need more.',
    );
    expect(r.domains).toEqual(["nutrition"]);
  });
});
