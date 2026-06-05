import { describe, expect, test } from "bun:test";
import {
  REMINDER_PROMPT,
  REMINDER_PROMPT_SIGNATURE,
  classifyPrefsReply,
  isPrefsAsked,
  readPrefs,
} from "./prefs.js";

describe("REMINDER_PROMPT", () => {
  test("contains the signature so process-incoming can detect a reply context", () => {
    expect(REMINDER_PROMPT).toContain(REMINDER_PROMPT_SIGNATURE);
  });
});

describe("classifyPrefsReply — timing (F7)", () => {
  test("defaults to morning_of for a bare time", () => {
    const r = classifyPrefsReply("6am");
    expect(r.kind).toBe("time_specified");
    if (r.kind === "time_specified") expect(r.timing).toBe("morning_of");
  });

  test("detects 'night before, 9pm' as night_before + 21:00", () => {
    const r = classifyPrefsReply("night before, 9pm");
    expect(r.kind).toBe("time_specified");
    if (r.kind === "time_specified") {
      expect(r.timing).toBe("night_before");
      expect(r.time_local).toBe("21:00");
    }
  });

  test("detects 'the evening before at 20:00'", () => {
    const r = classifyPrefsReply("the evening before at 20:00");
    expect(r.kind).toBe("time_specified");
    if (r.kind === "time_specified") {
      expect(r.timing).toBe("night_before");
      expect(r.time_local).toBe("20:00");
    }
  });

  test("readPrefs defaults timing to morning_of for legacy v1.1 prefs", () => {
    const p = readPrefs({ enabled: true, time_local: "06:00" });
    expect(p?.timing).toBe("morning_of");
  });

  test("readPrefs preserves a stored night_before timing", () => {
    const p = readPrefs({ enabled: true, time_local: "21:00", timing: "night_before" });
    expect(p?.timing).toBe("night_before");
  });
});

describe("classifyPrefsReply — decline", () => {
  test.each([
    "no",
    "No",
    "no thanks",
    "No thanks!",
    "no reminders",
    "skip",
    "don't",
    "nope",
    "pass",
  ])("treats %p as decline", (input) => {
    expect(classifyPrefsReply(input).kind).toBe("decline");
  });
});

describe("classifyPrefsReply — time_specified (12-hour with am/pm)", () => {
  test("parses '6am' to 06:00", () => {
    const r = classifyPrefsReply("6am");
    expect(r.kind).toBe("time_specified");
    if (r.kind === "time_specified") expect(r.time_local).toBe("06:00");
  });

  test("parses '6 AM' to 06:00", () => {
    const r = classifyPrefsReply("6 AM");
    expect(r.kind).toBe("time_specified");
    if (r.kind === "time_specified") expect(r.time_local).toBe("06:00");
  });

  test("parses '6:30am' to 06:30", () => {
    const r = classifyPrefsReply("6:30am");
    expect(r.kind).toBe("time_specified");
    if (r.kind === "time_specified") expect(r.time_local).toBe("06:30");
  });

  test("parses '7:15 PM' to 19:15", () => {
    const r = classifyPrefsReply("7:15 PM");
    expect(r.kind).toBe("time_specified");
    if (r.kind === "time_specified") expect(r.time_local).toBe("19:15");
  });

  test("parses '12am' to 00:00 (midnight)", () => {
    const r = classifyPrefsReply("12am");
    expect(r.kind).toBe("time_specified");
    if (r.kind === "time_specified") expect(r.time_local).toBe("00:00");
  });

  test("parses '12pm' to 12:00 (noon)", () => {
    const r = classifyPrefsReply("12pm");
    expect(r.kind).toBe("time_specified");
    if (r.kind === "time_specified") expect(r.time_local).toBe("12:00");
  });
});

describe("classifyPrefsReply — time_specified (24-hour)", () => {
  test("parses '06:00' to 06:00", () => {
    const r = classifyPrefsReply("06:00");
    expect(r.kind).toBe("time_specified");
    if (r.kind === "time_specified") expect(r.time_local).toBe("06:00");
  });

  test("parses '5:30' to 05:30", () => {
    const r = classifyPrefsReply("5:30");
    expect(r.kind).toBe("time_specified");
    if (r.kind === "time_specified") expect(r.time_local).toBe("05:30");
  });

  test("parses sentence containing time: 'let's do 6:00'", () => {
    const r = classifyPrefsReply("let's do 6:00");
    expect(r.kind).toBe("time_specified");
    if (r.kind === "time_specified") expect(r.time_local).toBe("06:00");
  });
});

describe("classifyPrefsReply — ambiguous", () => {
  test.each([
    "tell me more",
    "what does that mean",
    "hi",
    "🤔",
    "later",
  ])("treats %p as ambiguous", (input) => {
    expect(classifyPrefsReply(input).kind).toBe("ambiguous");
  });
});

describe("isPrefsAsked", () => {
  test("false when null / undefined (never asked)", () => {
    expect(isPrefsAsked(null)).toBe(false);
    expect(isPrefsAsked(undefined)).toBe(false);
  });

  test("true when prefs are persisted (declined or enabled)", () => {
    expect(isPrefsAsked({ enabled: false })).toBe(true);
    expect(isPrefsAsked({ enabled: true, time_local: "06:00" })).toBe(true);
  });
});

describe("readPrefs", () => {
  test("returns null for non-object input", () => {
    expect(readPrefs(null)).toBeNull();
    expect(readPrefs("string")).toBeNull();
  });

  test("returns null when enabled is missing", () => {
    expect(readPrefs({})).toBeNull();
  });

  test("parses a valid disabled prefs object", () => {
    const p = readPrefs({ enabled: false });
    expect(p).not.toBeNull();
    expect(p?.enabled).toBe(false);
    expect(p?.time_local).toBeUndefined();
  });

  test("parses a valid enabled prefs object", () => {
    const p = readPrefs({ enabled: true, time_local: "06:00" });
    expect(p).not.toBeNull();
    expect(p?.enabled).toBe(true);
    expect(p?.time_local).toBe("06:00");
  });

  test("drops malformed time_local", () => {
    const p = readPrefs({ enabled: true, time_local: "6am" });
    expect(p?.time_local).toBeUndefined();
  });
});
