import { describe, expect, test } from "bun:test";
import { splitForTelegram } from "./telegram-send.js";

describe("splitForTelegram", () => {
  test("short body is a single part", () => {
    expect(splitForTelegram("hello coach")).toEqual(["hello coach"]);
  });

  test("long body splits into <=4096-char parts with nothing lost", () => {
    const body = ("x".repeat(100) + "\n").repeat(80); // ~8080 chars, newline-friendly
    const parts = splitForTelegram(body);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    // Re-joining recovers the content (newline breaks are the split points).
    expect(parts.join("\n").replace(/\n+/g, "\n")).toBe(body.replace(/\n+/g, "\n"));
  });

  test("a single unbroken run over the limit still hard-splits", () => {
    const parts = splitForTelegram("y".repeat(5000));
    expect(parts.length).toBe(2);
    expect(parts[0]!.length).toBe(4096);
    expect(parts[1]!.length).toBe(904);
  });
});
