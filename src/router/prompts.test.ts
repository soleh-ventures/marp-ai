import { describe, expect, test } from "bun:test";
import {
  _resetPromptCache,
  getClassifierPrompt,
  getDomainPromptFile,
  getOnboardingPrompt,
  getPlanGeneratorPrompt,
  getSynthesizerPrompt,
  parseFrontmatter,
  validateAllPrompts,
} from "./prompts.js";
import { DOMAINS } from "./types.js";

describe("parseFrontmatter", () => {
  test("happy path: key/value + list of nested objects", () => {
    const r = parseFrontmatter(`---
domain: training
persona_id: training-coach-v1
references:
  - title: "Daniels' Running Formula"
    type: paraphrase
  - title: "ACSM Position Stand"
    type: cite
---
You are MARP's training coach.

More body text here.`);
    expect(r.frontmatter.domain).toBe("training");
    expect(r.frontmatter.persona_id).toBe("training-coach-v1");
    expect(r.frontmatter.references).toEqual([
      { title: "Daniels' Running Formula", type: "paraphrase" },
      { title: "ACSM Position Stand", type: "cite" },
    ]);
    expect(r.body).toBe("You are MARP's training coach.\n\nMore body text here.");
  });

  test("no frontmatter — whole file is body", () => {
    const r = parseFrontmatter("Just a plain body, no frontmatter.");
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe("Just a plain body, no frontmatter.");
  });

  test("throws on unterminated frontmatter", () => {
    expect(() => parseFrontmatter("---\nfoo: bar\n\nBody without closing fence")).toThrow();
  });
});

describe("prompt files on disk", () => {
  test("validateAllPrompts loads classifier, synthesizer, and all 6 domains", () => {
    _resetPromptCache();
    expect(() => validateAllPrompts()).not.toThrow();
  });

  test("classifier prompt mentions JSON output", () => {
    const body = getClassifierPrompt();
    expect(body.toLowerCase()).toContain("json");
    // Must list all 6 domains so the model has the routing vocabulary.
    for (const d of DOMAINS) {
      expect(body).toContain(d);
    }
  });

  test("synthesizer prompt mentions one voice + reconciliation", () => {
    const body = getSynthesizerPrompt();
    expect(body.toLowerCase()).toContain("synthesi");
    expect(body.toLowerCase()).toContain("contradict");
  });

  test("each domain prompt has frontmatter.domain matching its filename", () => {
    for (const d of DOMAINS) {
      const file = getDomainPromptFile(d);
      expect(file.frontmatter.domain).toBe(d);
      // Body should be substantial — at least 200 chars — otherwise the
      // prompt is too thin and the persona won't be coherent.
      expect(file.body.length).toBeGreaterThan(200);
    }
  });

  test("injury prompt mentions the pain-ladder colors", () => {
    const f = getDomainPromptFile("injury");
    // Domain-specific sanity check — injury MUST teach the 0–3/4–5/6+ ladder.
    expect(f.body).toMatch(/green|🟢/i);
    expect(f.body).toMatch(/yellow|🟡/i);
    expect(f.body).toMatch(/red|🔴/i);
  });

  // Regression: the v1.2 single-message rewrite dropped sex/height/weight
  // from the asked question while leaving them in the `basics` schema, so
  // they were never actually collected. The onboarding message must ask for
  // them and the plan generator must actually consume them — otherwise
  // they're dead schema again.
  test("onboarding prompt asks for sex, height, and weight", () => {
    const body = getOnboardingPrompt();
    // Must be in the asked QUESTION (a numbered "N. Your ..." list item),
    // not merely listed in the `- **basics**:` schema block — the v1.2 bug
    // was that the schema kept them while the question dropped them.
    const numberedItems = body
      .split("\n")
      .filter((l) => /^\s*>?\s*\d+\.\s/.test(l))
      .join("\n")
      .toLowerCase();
    expect(numberedItems).toContain("sex");
    expect(numberedItems).toContain("height");
    expect(numberedItems).toContain("weight");
  });

  test("plan-generator prompt uses sex/height/weight physiology", () => {
    const body = getPlanGeneratorPrompt().toLowerCase();
    // The dedicated physiology rule must reference all three inputs.
    expect(body).toContain("weight");
    expect(body).toContain("height");
    expect(body).toContain("sex");
    // And tie weight to a concrete coaching lever (load and/or fueling),
    // not just mention it in passing.
    expect(body).toMatch(/bmi|fuel|load/);
  });

  // M1 (T7): prescription must carry a target RPE (1-10) so it speaks the
  // same effort language MARP reads back in the post-run feeling capture.
  test("plan-generator prompt anchors a target RPE on sessions", () => {
    const body = getPlanGeneratorPrompt().toLowerCase();
    expect(body).toContain("rpe");
    expect(body).toMatch(/1[\s–-]*10|perceived/);
  });

  test("every domain prompt has a 'Cite the principle' section (ET18 / CEO S1)", () => {
    // E14 content-licensing guard: each domain MUST instruct the LLM to
    // cite the underlying principle when making strong recommendations.
    // The presence of this section is the contract; T12 evals will
    // measure whether the LLM actually obeys it.
    for (const d of DOMAINS) {
      const f = getDomainPromptFile(d);
      expect(f.body).toMatch(/# Cite the principle/);
      // Sanity: each section must also explicitly forbid verbatim quotes
      // (the E14 boundary). One way to check: the words "page numbers"
      // and "verbatim" both appear under the section.
      expect(f.body).toMatch(/page numbers/);
      expect(f.body).toMatch(/verbatim/);
    }
  });
});
