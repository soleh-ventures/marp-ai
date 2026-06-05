import { describe, expect, test } from "bun:test";
import { inferTimezoneFromPhone } from "./timezone.js";

describe("inferTimezoneFromPhone", () => {
  test("maps +49 → Europe/Berlin", () => {
    expect(inferTimezoneFromPhone("+4915123456789")).toBe("Europe/Berlin");
  });

  test("maps +1 → America/New_York (US default)", () => {
    expect(inferTimezoneFromPhone("+12025551234")).toBe("America/New_York");
  });

  test("maps +62 → Asia/Jakarta", () => {
    expect(inferTimezoneFromPhone("+628123456789")).toBe("Asia/Jakarta");
  });

  test("prefers longest matching prefix (3 over 2 over 1)", () => {
    // +44 is UK, but +441 would NOT match a 3-digit code — so it falls
    // back to 2-digit +44. +1 should NOT shadow +1234 if +1234 existed.
    // We don't have +1xxx codes in v1.1, so +12... goes to +1.
    expect(inferTimezoneFromPhone("+441234567890")).toBe("Europe/London");
  });

  test("strips whatsapp: prefix", () => {
    expect(inferTimezoneFromPhone("whatsapp:+49151234567")).toBe(
      "Europe/Berlin",
    );
  });

  test("returns null for unknown country code", () => {
    // +999 isn't a real country code
    expect(inferTimezoneFromPhone("+999123")).toBeNull();
  });

  test("returns null for non-numeric input", () => {
    expect(inferTimezoneFromPhone("+abc")).toBeNull();
  });
});
