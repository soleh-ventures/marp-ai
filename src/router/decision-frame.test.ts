import { describe, expect, test } from "bun:test";
import { extractDecisionFrame } from "./decision-frame.js";

describe("extractDecisionFrame", () => {
  test("returns raw text and null frame when no tag is present", () => {
    const r = extractDecisionFrame("Just a normal reply without a fork.");
    expect(r.text).toBe("Just a normal reply without a fork.");
    expect(r.frame).toBeNull();
    expect(r.parseFailed).toBe(false);
  });

  test("strips the tag from the runner-facing text", () => {
    const reply =
      "Two reasonable paths today.\n\n" +
      `<decision_frame>{"question":"Tempo or easy?","options":[{"key":"tempo","label":"Run the tempo"},{"key":"easy","label":"Swap to easy 30min"}]}</decision_frame>`;
    const r = extractDecisionFrame(reply);
    expect(r.text).toBe("Two reasonable paths today.");
    expect(r.frame).not.toBeNull();
    expect(r.frame?.options).toHaveLength(2);
    expect(r.frame?.options[0]?.key).toBe("tempo");
  });

  test("captures action_hint when present, leaves it off when missing", () => {
    const reply =
      `<decision_frame>{"question":"X?","options":[{"key":"a","label":"A","action_hint":"if HR settles"},{"key":"b","label":"B"}]}</decision_frame>`;
    const r = extractDecisionFrame(reply);
    expect(r.frame?.options[0]?.action_hint).toBe("if HR settles");
    expect(r.frame?.options[1]?.action_hint).toBeUndefined();
  });

  test("returns parseFailed=true on malformed JSON, but still strips the tag", () => {
    const reply =
      "Here's the call.\n<decision_frame>{ this is not json }</decision_frame>";
    const r = extractDecisionFrame(reply);
    expect(r.text).toBe("Here's the call.");
    expect(r.frame).toBeNull();
    expect(r.parseFailed).toBe(true);
  });

  test("rejects frames with no options (parseFailed=true)", () => {
    const reply = `<decision_frame>{"question":"X?","options":[]}</decision_frame>`;
    const r = extractDecisionFrame(reply);
    expect(r.frame).toBeNull();
    expect(r.parseFailed).toBe(true);
  });

  test("rejects options with missing key/label", () => {
    const reply = `<decision_frame>{"question":"X?","options":[{"label":"missing key"}]}</decision_frame>`;
    const r = extractDecisionFrame(reply);
    expect(r.frame).toBeNull();
    expect(r.parseFailed).toBe(true);
  });

  test("rejects duplicate option keys (binder needs them unique)", () => {
    const reply =
      `<decision_frame>{"question":"X?","options":[{"key":"a","label":"A"},{"key":"a","label":"Also A"}]}</decision_frame>`;
    const r = extractDecisionFrame(reply);
    expect(r.frame).toBeNull();
    expect(r.parseFailed).toBe(true);
  });

  test("tolerates whitespace + trailing newline around the tag", () => {
    const reply =
      "Text.\n\n  <decision_frame>\n  {\"question\":\"X?\",\"options\":[{\"key\":\"a\",\"label\":\"A\"}]}\n  </decision_frame>\n\n";
    const r = extractDecisionFrame(reply);
    expect(r.text).toBe("Text.");
    expect(r.frame?.options[0]?.key).toBe("a");
  });

  test("ignores frames that aren't at the very end of the reply", () => {
    // We only support tail-anchored frames. A frame embedded mid-reply
    // is treated as raw text — LLM was confused, ship the natural-language.
    const reply =
      `<decision_frame>{"question":"X?","options":[{"key":"a","label":"A"}]}</decision_frame>\n\nAnd here's some text after.`;
    const r = extractDecisionFrame(reply);
    expect(r.frame).toBeNull();
    expect(r.parseFailed).toBe(false);
  });
});
