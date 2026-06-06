import { describe, expect, test } from "bun:test";
import {
  emergencyNumberFor,
  emergencyResponse,
  referralNotice,
  referralPrefixFor,
} from "./responses.js";

describe("emergencyNumberFor (S1 region-aware)", () => {
  test("US/CA → 911", () => {
    expect(emergencyNumberFor("US")).toBe("911");
    expect(emergencyNumberFor("ca")).toBe("911"); // case-insensitive
  });
  test("EU country defaults to 112", () => {
    expect(emergencyNumberFor("DE")).toBe("112");
    expect(emergencyNumberFor("FR")).toBe("112");
  });
  test("GB → 999 or 112, AU → 000", () => {
    expect(emergencyNumberFor("GB")).toContain("999");
    expect(emergencyNumberFor("AU")).toBe("000");
  });
  test("unknown/null → both common numbers, no crash", () => {
    expect(emergencyNumberFor(null)).toContain("112");
    expect(emergencyNumberFor(null)).toContain("911");
  });
});

describe("emergencyResponse (S1)", () => {
  test("is scripted, names the number, and offers no coaching", () => {
    const msg = emergencyResponse("US");
    expect(msg).toContain("911");
    expect(msg).toContain("emergency");
    expect(msg.toLowerCase()).not.toContain("training");
  });
});

describe("referral notices (S1)", () => {
  test("each category has a referral; unknown falls back to other_medical", () => {
    expect(referralNotice("ed_reds").toLowerCase()).toContain("dietitian");
    expect(referralNotice("pregnancy").toLowerCase()).toContain("doctor");
    expect(referralNotice("injury_red_flag").toLowerCase()).toMatch(/physio|doctor/);
    expect(referralNotice("totally_unknown")).toBe(referralNotice("other_medical"));
  });

  test("referralPrefixFor prepends only for referral tier", () => {
    expect(referralPrefixFor({ tier: "referral", category: "ed_reds", reason: "" })).toContain(
      "dietitian",
    );
    expect(referralPrefixFor({ tier: "none", category: "none", reason: "" })).toBe("");
    expect(referralPrefixFor({ tier: "emergency", category: "cardiac", reason: "" })).toBe("");
  });
});
