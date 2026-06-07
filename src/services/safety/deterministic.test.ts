import { describe, expect, test } from "bun:test";
import { combineTriage, screenDeterministic } from "./deterministic.js";

// The deterministic floor is the durable guardrail: it must catch the
// unambiguous worst cases with NO LLM involved, and never fire on ordinary
// running talk. These tests are the always-green proof of that.
describe("screenDeterministic — emergencies (no LLM)", () => {
  const emergencies = [
    "I want to die",
    "I keep thinking about killing myself",
    "I don't want to be here anymore",
    "I've been hurting myself",
    "I can't breathe properly right now",
    "I'm gasping for air",
    "my friend collapsed and is unresponsive",
    "I passed out on my run",
    "I blacked out after the workout",
    // Review: these must-catch emergencies now have a deterministic floor.
    "I just had a seizure after my run",
    "half my face is drooping and my speech went slurred",
    "I gashed my leg and it won't stop bleeding",
    "I think I took too many pills",
    "I overdosed last night",
    "I stopped sweating, I think it's heat stroke",
    "sudden worst headache of my life mid-run",
  ];
  for (const m of emergencies) {
    test(`emergency: "${m}"`, () => {
      expect(screenDeterministic(m).tier).toBe("emergency");
    });
  }
});

describe("screenDeterministic — referrals (no LLM)", () => {
  const referrals = [
    "I get chest pain when I run",
    "my chest feels tight on the climbs",
    "I make myself throw up after eating",
    "I've been purging after big meals",
    "I haven't had my period in months",
    "I lost my period since upping mileage",
    "I've been skipping meals to drop weight",
    "I'm basically starving myself before the race",
  ];
  for (const m of referrals) {
    test(`referral: "${m}"`, () => {
      expect(screenDeterministic(m).tier).toBe("referral");
    });
  }
});

describe("screenDeterministic — must NOT fire on ordinary running talk", () => {
  const safe = [
    "how do I taper for my marathon?",
    "my legs are sore after the long run",
    "what should I eat before a race?",
    "I'm breathing hard on the hills but feel strong",
    "I ate a big breakfast then ran",
    "should I do a chest workout on cross-training days?",
    "I died on that last interval lol",
  ];
  for (const m of safe) {
    test(`none: "${m}"`, () => {
      expect(screenDeterministic(m).tier).toBe("none");
    });
  }
});

describe("combineTriage", () => {
  const E = { tier: "emergency" as const, category: "x", reason: "" };
  const R = { tier: "referral" as const, category: "x", reason: "" };
  const N = { tier: "none" as const, category: "none", reason: "" };

  test("floor escalates over a softer LLM result", () => {
    expect(combineTriage(E, N).tier).toBe("emergency");
    expect(combineTriage(R, N).tier).toBe("referral");
  });
  test("LLM escalates over a softer floor", () => {
    expect(combineTriage(N, E).tier).toBe("emergency");
    expect(combineTriage(R, E).tier).toBe("emergency");
  });
  test("never downgrades", () => {
    expect(combineTriage(E, R).tier).toBe("emergency");
  });
});
