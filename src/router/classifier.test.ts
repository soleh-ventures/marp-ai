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

  test("F4-a: complexity defaults to coaching when absent (conservative)", () => {
    const r = parseRouting(
      '{"domains":["training"],"confidence":0.9,"rationale":"x"}',
    );
    expect(r.complexity).toBe("coaching");
  });

  test("F4-a: parses an explicit small_talk tag", () => {
    const r = parseRouting(
      '{"domains":["mental"],"confidence":0.3,"rationale":"greeting","complexity":"small_talk"}',
    );
    expect(r.complexity).toBe("small_talk");
  });

  test("F4-a: an unknown complexity value falls back to coaching", () => {
    const r = parseRouting(
      '{"domains":["training"],"confidence":0.9,"rationale":"x","complexity":"banana"}',
    );
    expect(r.complexity).toBe("coaching");
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

  // ── ET5: is_fork + resolves_decision ────────────────────────────────

  test("defaults isFork=false and resolvesDecision=null when the LLM omits them", () => {
    const r = parseRouting(
      '{"domains":["training"],"confidence":0.9,"rationale":""}',
    );
    expect(r.isFork).toBe(false);
    expect(r.resolvesDecision).toBeNull();
  });

  test("parses isFork=true when the classifier flags a fork", () => {
    const r = parseRouting(
      '{"domains":["training"],"confidence":0.85,"rationale":"two-path question","is_fork":true,"resolves_decision":null}',
    );
    expect(r.isFork).toBe(true);
    expect(r.resolvesDecision).toBeNull();
  });

  test("parses resolvesDecision when classifier emits a key", () => {
    // Classifier emits null in v1 (the binder owns matching), but the
    // parser still has to accept a string for forward-compat.
    const r = parseRouting(
      '{"domains":["training"],"confidence":0.95,"rationale":"short choice reply","is_fork":false,"resolves_decision":"rest"}',
    );
    expect(r.resolvesDecision).toBe("rest");
  });

  test("treats truthy non-bool is_fork as false (strict bool only)", () => {
    const r = parseRouting(
      '{"domains":["training"],"confidence":0.5,"rationale":"","is_fork":"yes"}',
    );
    expect(r.isFork).toBe(false);
  });

  test("treats empty-string resolves_decision as null", () => {
    const r = parseRouting(
      '{"domains":["training"],"confidence":0.5,"rationale":"","is_fork":false,"resolves_decision":""}',
    );
    expect(r.resolvesDecision).toBeNull();
  });
});
