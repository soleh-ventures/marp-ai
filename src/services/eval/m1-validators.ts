// M1 (T8) — rule-based validators for the coaching-loop prompt evals.
//
// Pure: given a fixture + the raw LLM output, return a per-check verdict.
// Reuses the PRODUCTION parsers (parseFeeling, parseProposal) so the eval
// grades exactly what the app would ingest. The runner (eval-m1.ts) applies
// the pass-rate threshold.

import { parseFeeling } from "../run-feeling.js";
import { parseProposal } from "../run-retro.js";
import type { AnalysisFixture, FeelingFixture, RetroFixture } from "./m1-fixtures.js";

export type CheckResult = { id: string; pass: boolean; detail: string };
export type FixtureVerdict = { fixture: string; checks: CheckResult[]; pass: boolean };

function verdict(name: string, checks: CheckResult[]): FixtureVerdict {
  return { fixture: name, checks, pass: checks.every((c) => c.pass) };
}

// ── post-run-analysis ──────────────────────────────────────────────────────
export function checkAnalysis(coachRead: string, fx: AnalysisFixture): FixtureVerdict {
  const text = coachRead.trim();
  const checks: CheckResult[] = [
    { id: "non_empty", pass: text.length > 0 && text.length <= 400, detail: `${text.length} chars` },
    {
      id: "not_a_question",
      pass: !text.includes("?"),
      detail: text.includes("?") ? "contains a question (should be a read)" : "statement",
    },
  ];
  if (fx.expectMentions.length > 0) {
    const lc = text.toLowerCase();
    const hit = fx.expectMentions.some((m) => lc.includes(m.toLowerCase()));
    checks.push({
      id: "grounded_mention",
      pass: hit,
      detail: hit ? `mentions one of [${fx.expectMentions.join(", ")}]` : `missing any of [${fx.expectMentions.join(", ")}]`,
    });
  }
  return verdict(fx.name, checks);
}

// ── feeling-extract ──────────────────────────────────────────────────────
export function checkFeeling(raw: string, fx: FeelingFixture): FixtureVerdict {
  const feeling = parseFeeling(raw, fx.message);
  const checks: CheckResult[] = [
    {
      id: "captured_matches",
      pass: (feeling !== null) === fx.expect.captured,
      detail: `parsed=${feeling !== null}, expected=${fx.expect.captured}`,
    },
  ];
  if (fx.expect.captured && feeling) {
    if (fx.expect.rpe !== undefined) {
      checks.push({ id: "rpe", pass: feeling.effort.rpe === fx.expect.rpe, detail: `rpe=${feeling.effort.rpe}, expected ${fx.expect.rpe}` });
    }
    if (fx.expect.band !== undefined) {
      checks.push({ id: "band", pass: feeling.effort.band === fx.expect.band, detail: `band=${feeling.effort.band}, expected ${fx.expect.band}` });
    }
    if (fx.expect.pain !== undefined) {
      checks.push({ id: "pain", pass: feeling.pain.present === fx.expect.pain, detail: `pain=${feeling.pain.present}, expected ${fx.expect.pain}` });
    }
    if (fx.expect.adherence !== undefined) {
      checks.push({ id: "adherence", pass: feeling.adherence === fx.expect.adherence, detail: `adherence=${feeling.adherence}, expected ${fx.expect.adherence}` });
    }
  }
  return verdict(fx.name, checks);
}

// ── retro-proposal ──────────────────────────────────────────────────────
// Words that signal a load INCREASE — forbidden in an accepted change when the
// week shows fatigue or an open injury (noLoadIncrease fixtures).
const INCREASE_RE = /\b(increase|add(?:ing)?|ramp(?:ing)? up|more (?:volume|mileage|km)|harder|push(?:ing)? (?:more|harder)|bump (?:up|volume))\b/i;

export function checkRetro(raw: string, fx: RetroFixture): FixtureVerdict {
  const proposal = parseProposal(raw);
  const didAdjust = proposal !== null;
  const checks: CheckResult[] = [
    {
      id: "adjust_matches",
      pass: didAdjust === fx.expect.adjust,
      detail: `adjust=${didAdjust}, expected=${fx.expect.adjust}`,
    },
  ];
  if (didAdjust && proposal) {
    const hasAccept = proposal.decision_frame.options.some((o) => o.key === "accept");
    checks.push({ id: "frame_has_accept", pass: hasAccept, detail: hasAccept ? "accept option present" : "no 'accept' option key" });
    if (fx.expect.noLoadIncrease) {
      const increases = INCREASE_RE.test(proposal.edit_request);
      checks.push({
        id: "no_load_increase",
        pass: !increases,
        detail: increases ? `edit_request increases load under fatigue/injury: "${proposal.edit_request}"` : "no load increase",
      });
    }
  }
  return verdict(fx.name, checks);
}
