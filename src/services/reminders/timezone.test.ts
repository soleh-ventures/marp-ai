import { describe, expect, test } from "bun:test";
import {
  extractIanaFromStravaTz,
  inferCountryFromPhone,
  inferTimezoneFromPhone,
  nextMonday,
  nowInZone,
  resolveTimezone,
} from "./timezone.js";

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

describe("inferCountryFromPhone (F8b)", () => {
  test("maps +49 → DE", () => {
    expect(inferCountryFromPhone("+4915123456789")).toBe("DE");
  });
  test("maps +62 → ID", () => {
    expect(inferCountryFromPhone("+628123456789")).toBe("ID");
  });
  test("maps +1 → US", () => {
    expect(inferCountryFromPhone("whatsapp:+12025551234")).toBe("US");
  });
  test("prefers longest prefix (+351 → PT, not +35/+3)", () => {
    expect(inferCountryFromPhone("+351912345678")).toBe("PT");
  });
  test("returns null for unknown code", () => {
    expect(inferCountryFromPhone("+999123")).toBeNull();
  });
});

describe("resolveTimezone (F8)", () => {
  test("prefers the stored timezone", () => {
    expect(resolveTimezone("Asia/Tokyo", "+4915123456789")).toBe("Asia/Tokyo");
  });
  test("falls back to phone inference when no stored tz", () => {
    expect(resolveTimezone(null, "+4915123456789")).toBe("Europe/Berlin");
  });
  test("falls back to UTC when both unknown", () => {
    expect(resolveTimezone(null, "+999123")).toBe("UTC");
  });
});

describe("nowInZone (F8)", () => {
  // Fixed instant: 2026-06-05T08:40:00Z — Friday in Berlin (UTC+2 → 10:40).
  const fri = new Date("2026-06-05T08:40:00Z");

  test("computes date + weekday + time in the resolved zone", () => {
    const z = nowInZone("Europe/Berlin", "+4915123456789", fri);
    expect(z.date).toBe("2026-06-05");
    expect(z.weekday).toBe("friday");
    expect(z.timezone).toBe("Europe/Berlin");
    // 08:40Z is 10:40 in Berlin (UTC+2 summer).
    expect(z.time).toBe("10:40");
  });

  test("crosses the date line + clock for a far-east zone", () => {
    // 08:40Z is 17:40 in Tokyo, still Friday the 5th.
    const z = nowInZone("Asia/Tokyo", "+819012345678", fri);
    expect(z.date).toBe("2026-06-05");
    expect(z.weekday).toBe("friday");
    expect(z.time).toBe("17:40");
  });

  test("a late-evening Berlin instant is still the local day, not UTC next-day", () => {
    // 2026-06-05T22:30Z = 00:30 on the 6th in Berlin (UTC+2).
    const lateUtc = new Date("2026-06-05T22:30:00Z");
    const z = nowInZone("Europe/Berlin", "+4915123456789", lateUtc);
    expect(z.date).toBe("2026-06-06");
    expect(z.weekday).toBe("saturday");
  });
});

describe("extractIanaFromStravaTz (F8c)", () => {
  test("pulls the IANA name from a Strava timezone string", () => {
    expect(extractIanaFromStravaTz("(GMT-05:00) America/New_York")).toBe(
      "America/New_York",
    );
  });
  test("handles a positive offset", () => {
    expect(extractIanaFromStravaTz("(GMT+01:00) Europe/Berlin")).toBe(
      "Europe/Berlin",
    );
  });
  test("accepts a bare IANA name with no offset prefix", () => {
    expect(extractIanaFromStravaTz("Asia/Tokyo")).toBe("Asia/Tokyo");
  });
  test("handles three-segment zones", () => {
    expect(
      extractIanaFromStravaTz("(GMT-03:00) America/Argentina/Buenos_Aires"),
    ).toBe("America/Argentina/Buenos_Aires");
  });
  test("rejects a non-IANA / garbage zone", () => {
    expect(extractIanaFromStravaTz("(GMT+00:00) Narnia/Cair_Paravel")).toBeNull();
  });
  test("returns null for non-string / missing input", () => {
    expect(extractIanaFromStravaTz(undefined)).toBeNull();
    expect(extractIanaFromStravaTz(42)).toBeNull();
  });
});

describe("nextMonday (F8)", () => {
  test("Friday → the following Monday", () => {
    const fri = new Date("2026-06-05T08:40:00Z");
    expect(nextMonday("Europe/Berlin", "+4915123456789", fri)).toBe("2026-06-08");
  });
  test("a Monday returns itself (0 days added)", () => {
    const mon = new Date("2026-06-08T08:00:00Z");
    expect(nextMonday("Europe/Berlin", "+4915123456789", mon)).toBe("2026-06-08");
  });
  test("a Sunday returns the very next day", () => {
    const sun = new Date("2026-06-07T08:00:00Z");
    expect(nextMonday("Europe/Berlin", "+4915123456789", sun)).toBe("2026-06-08");
  });
});
