import { describe, expect, test } from "bun:test";
import { splitForWhatsApp } from "./whatsapp-split.js";

describe("splitForWhatsApp (KER-72)", () => {
  test("returns a single part when under the limit", () => {
    const body = "short message";
    expect(splitForWhatsApp(body, 1500)).toEqual([body]);
  });

  test("never truncates — every char survives across the parts", () => {
    // 5 paragraphs of 100 chars each, limit 250 → must split, lose nothing.
    const paras = Array.from({ length: 5 }, (_, i) =>
      `${i}`.repeat(100),
    );
    const body = paras.join("\n\n");
    const parts = splitForWhatsApp(body, 250);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(250);
    // Rejoining the original paragraphs must reproduce every paragraph.
    const flat = parts.join("\n\n");
    for (const para of paras) expect(flat).toContain(para);
  });

  test("does not append an ellipsis (the old truncation bug)", () => {
    const body = "a".repeat(2000);
    const parts = splitForWhatsApp(body, 1500);
    expect(parts.join("")).not.toContain("...");
    expect(parts.join("")).toBe(body);
  });

  test("splits a single oversized paragraph on sentence boundaries", () => {
    const sentences = Array.from(
      { length: 10 },
      (_, i) => `Sentence number ${i} goes here.`,
    );
    const body = sentences.join(" ");
    const parts = splitForWhatsApp(body, 80);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(80);
    for (const s of sentences) expect(body).toContain(s);
  });

  test("hard-slices a pathological single token (long URL)", () => {
    const body = "https://example.com/" + "x".repeat(3000);
    const parts = splitForWhatsApp(body, 1500);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1500);
    expect(parts.join("")).toBe(body);
  });

  test("keeps short multi-paragraph bodies in one part", () => {
    const body = "Hello there.\n\nHow are you?";
    expect(splitForWhatsApp(body, 1500)).toEqual([body]);
  });
});
