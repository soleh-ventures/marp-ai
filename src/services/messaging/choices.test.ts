import { describe, expect, it } from "bun:test";
import {
  buildInlineKeyboard,
  decodeCallback,
  encodeCallback,
  matchFreeText,
  renderTextFallback,
  type ChoiceQuestion,
} from "./choices.js";

const COACH: ChoiceQuestion = {
  id: "coach",
  choices: [
    { value: "director", label: "🎯 Director", synonyms: ["hard"] },
    { value: "partner", label: "⚖️ Partner", synonyms: ["balanced"] },
    { value: "companion", label: "🤝 Companion", synonyms: ["easy", "friend"] },
    { value: "delegate", label: "You decide, coach", synonyms: ["you decide"] },
  ],
};

describe("callback codec", () => {
  it("round-trips", () => {
    const data = encodeCallback("coach", "director");
    expect(data).toBe("v1:coach:director");
    expect(decodeCallback(data)).toEqual({ questionId: "coach", value: "director" });
  });

  it("rejects unknown versions (old buttons after a format change)", () => {
    expect(decodeCallback("v0:coach:director")).toBeNull();
    expect(decodeCallback("v2:coach:director")).toBeNull();
  });

  it("rejects garbage and truncated data", () => {
    expect(decodeCallback("")).toBeNull();
    expect(decodeCallback("v1:coach")).toBeNull();
    expect(decodeCallback("v1::")).toBeNull();
    expect(decodeCallback("pref:coach:hard")).toBeNull();
    expect(decodeCallback("v1:a:b:c")).toBeNull();
  });

  it("throws on data over Telegram's 64-byte cap", () => {
    expect(() => encodeCallback("q".repeat(40), "v".repeat(40))).toThrow(/64-byte/);
  });
});

describe("inline keyboard", () => {
  it("renders one button per row with encoded callback data", () => {
    const kb = buildInlineKeyboard(COACH);
    expect(kb.inline_keyboard).toHaveLength(4);
    expect(kb.inline_keyboard[0]![0]).toEqual({
      text: "🎯 Director",
      callback_data: "v1:coach:director",
    });
  });
});

describe("text fallback", () => {
  it("renders numbered options with a reply hint", () => {
    const text = renderTextFallback(COACH);
    expect(text).toContain("1. 🎯 Director");
    expect(text).toContain("4. You decide, coach");
    expect(text).toContain("Reply 1, 2, 3 or 4.");
  });
});

describe("lenient matcher", () => {
  it("matches option numbers", () => {
    expect(matchFreeText(COACH, "1")).toBe("director");
    expect(matchFreeText(COACH, "2.")).toBe("partner");
    expect(matchFreeText(COACH, "option 3")).toBe("companion");
    expect(matchFreeText(COACH, "9")).toBeNull();
  });

  it("matches canonical values, labels, and synonyms", () => {
    expect(matchFreeText(COACH, "director")).toBe("director");
    expect(matchFreeText(COACH, "🎯 Director")).toBe("director");
    expect(matchFreeText(COACH, "hard")).toBe("director");
    expect(matchFreeText(COACH, "Balanced")).toBe("partner");
    expect(matchFreeText(COACH, "friend")).toBe("companion");
    expect(matchFreeText(COACH, "you decide")).toBe("delegate");
  });

  it("matches filler-wrapped single options", () => {
    expect(matchFreeText(COACH, "the hard one")).toBe("director");
    expect(matchFreeText(COACH, "go with partner")).toBe("partner");
  });

  it("NEVER matches long messages (the 'yesterday's run was really hard' guard)", () => {
    expect(matchFreeText(COACH, "yesterday's run was really hard")).toBeNull();
    expect(
      matchFreeText(COACH, "I had a hard time sleeping and my legs feel easy today"),
    ).toBeNull();
  });

  it("returns null for ambiguous or off-topic short text", () => {
    expect(matchFreeText(COACH, "hard easy")).toBeNull();
    expect(matchFreeText(COACH, "what is this?")).toBeNull();
    expect(matchFreeText(COACH, "")).toBeNull();
    expect(matchFreeText(COACH, "tempo run")).toBeNull();
  });
});
