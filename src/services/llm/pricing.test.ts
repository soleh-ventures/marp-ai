import { describe, expect, test } from "bun:test";
import { estimateCostUsd } from "./pricing.js";

// Per-million-token prices for the models we test against. Keeping
// them here as constants so the test stays readable when the source
// table changes.
const SONNET = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-4-5";
const SONNET_IN_PER_M = 3.0;
const SONNET_OUT_PER_M = 15.0;
const HAIKU_IN_PER_M = 1.0;
const HAIKU_OUT_PER_M = 5.0;

describe("estimateCostUsd", () => {
  test("no caching: charges all input at the base rate", () => {
    // 1000 input tokens + 500 output tokens, no cache.
    const cost = estimateCostUsd(SONNET, 1000, 500);
    const expected =
      (1000 / 1_000_000) * SONNET_IN_PER_M +
      (500 / 1_000_000) * SONNET_OUT_PER_M;
    expect(cost).toBeCloseTo(expected, 10);
  });

  test("full cache-hit: charges cache-read at 10% of input rate", () => {
    // All 2000 input tokens served from cache; 500 output.
    const cost = estimateCostUsd(SONNET, 2000, 500, 2000);
    const expected =
      (2000 / 1_000_000) * SONNET_IN_PER_M * 0.10 +
      (500 / 1_000_000) * SONNET_OUT_PER_M;
    expect(cost).toBeCloseTo(expected, 10);
  });

  test("partial cache: splits tokensIn between fresh and cache-read", () => {
    // 2500 total input, 2000 from cache + 500 fresh (user message).
    // Output: 200.
    const cost = estimateCostUsd(SONNET, 2500, 200, 2000);
    const fresh = (500 / 1_000_000) * SONNET_IN_PER_M;
    const cached = (2000 / 1_000_000) * SONNET_IN_PER_M * 0.10;
    const out = (200 / 1_000_000) * SONNET_OUT_PER_M;
    expect(cost).toBeCloseTo(fresh + cached + out, 10);
  });

  test("caching savings: cache-hit cost is dramatically below uncached for the same token count", () => {
    // Same total volume, comparing all-fresh vs all-cached.
    const uncached = estimateCostUsd(SONNET, 2000, 0);
    const cached = estimateCostUsd(SONNET, 2000, 0, 2000);
    // 10% cache rate → 90% savings on the input side.
    expect(cached).toBeCloseTo(uncached * 0.10, 10);
  });

  test("clamps cacheReadTokens > tokensIn defensively (no negative regular share)", () => {
    // Pathological input — cacheRead larger than tokensIn. Should treat
    // the entire input as cached rather than producing a negative
    // regular-token share + a negative cost.
    const cost = estimateCostUsd(SONNET, 1000, 100, 5000);
    const expected =
      (1000 / 1_000_000) * SONNET_IN_PER_M * 0.10 +
      (100 / 1_000_000) * SONNET_OUT_PER_M;
    expect(cost).toBeCloseTo(expected, 10);
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  test("negative cacheReadTokens treated as 0 (full base rate)", () => {
    const cost = estimateCostUsd(HAIKU, 1000, 100, -50);
    const expected =
      (1000 / 1_000_000) * HAIKU_IN_PER_M +
      (100 / 1_000_000) * HAIKU_OUT_PER_M;
    expect(cost).toBeCloseTo(expected, 10);
  });

  test("unknown model returns 0 (graceful degradation, dashboard surfaces gap)", () => {
    expect(estimateCostUsd("claude-future-99", 1000, 500)).toBe(0);
    expect(estimateCostUsd("claude-future-99", 1000, 500, 800)).toBe(0);
  });

  test("mock provider stays free regardless of caching", () => {
    expect(estimateCostUsd("mock", 5000, 5000)).toBe(0);
    expect(estimateCostUsd("mock", 5000, 5000, 4000)).toBe(0);
  });

  test("backwards-compatible call shape: cacheReadTokens defaults to 0", () => {
    const a = estimateCostUsd(SONNET, 1000, 500);
    const b = estimateCostUsd(SONNET, 1000, 500, 0);
    expect(a).toBe(b);
  });
});
