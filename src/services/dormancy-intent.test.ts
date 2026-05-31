import { describe, expect, test } from "bun:test";
import {
  type DormancyResponse,
  classifyDormancyResponse,
} from "./dormancy-intent.js";

describe("classifyDormancyResponse", () => {
  test.each<[string, DormancyResponse]>([
    ["YES", "resume"],
    ["yes", "resume"],
    ["  Yes  ", "resume"],
    ["RESUME", "resume"],
    ["resume", "resume"],
  ])("classifies %s as resume", (input, expected) => {
    expect(classifyDormancyResponse(input)).toBe(expected);
  });

  test.each<[string, DormancyResponse]>([
    ["NEW", "restart"],
    ["new", "restart"],
    ["RESTART", "restart"],
    ["restart", "restart"],
    ["FRESH", "restart"],
    ["  fresh ", "restart"],
  ])("classifies %s as restart", (input, expected) => {
    expect(classifyDormancyResponse(input)).toBe(expected);
  });

  test.each([
    ["hi"],
    ["hello"],
    ["what's up"],
    ["yes please"], // not exact
    ["yes, resume"], // not exact
    ["delete my account"], // wrong intent
    [""],
  ])("classifies %s as unclear", (input) => {
    expect(classifyDormancyResponse(input)).toBe("unclear");
  });
});
