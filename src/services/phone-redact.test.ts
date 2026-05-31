import { describe, expect, test } from "bun:test";
import { redactPhone } from "./phone-redact.js";

describe("redactPhone", () => {
  test("retains country code + last 4 digits of an E.164 number", () => {
    expect(redactPhone("+15551234567")).toBe("+***4567");
  });

  test("strips the whatsapp: prefix Twilio attaches on inbound", () => {
    expect(redactPhone("whatsapp:+628123456789")).toBe("+***6789");
  });

  test("handles a number with no + sign", () => {
    expect(redactPhone("15551234567")).toBe("***4567");
  });

  test("strips non-digits before slicing", () => {
    expect(redactPhone("+1 (555) 123-4567")).toBe("+***4567");
  });

  test("stubs entirely when the input is too short to be useful", () => {
    expect(redactPhone("+12")).toBe("+***");
  });

  test("returns a stable sentinel for null / undefined / empty", () => {
    expect(redactPhone(null)).toBe("<no-phone>");
    expect(redactPhone(undefined)).toBe("<no-phone>");
    expect(redactPhone("")).toBe("<no-phone>");
  });

  test("never returns the original number even for unusual inputs", () => {
    const original = "+15551234567";
    expect(redactPhone(original)).not.toContain("123");
    expect(redactPhone(original)).not.toContain("5551");
  });
});
