#!/usr/bin/env bun
/**
 * M1 (T8) — coaching-loop eval runner.
 *
 * Runs the three new prompts (post-run-analysis, feeling-extract,
 * retro-proposal) against their fixtures and grades each with the pure
 * validators. Mirrors eval-plan.ts: live provider + the same system prompts
 * the production path uses, rule-based verdicts, exits 0 if pass rate ≥ 80%.
 *
 * Usage:  bun run eval:m1     (needs ANTHROPIC_API_KEY; not in CI)
 *
 * The retro fixtures are the deepest set — it's the prompt that mutates plans.
 */

import { config } from "../config.js";
import { getProvider } from "../services/llm/index.js";
import {
  ANALYSIS_FIXTURES,
  FEELING_FIXTURES,
  RETRO_FIXTURES,
} from "../services/eval/m1-fixtures.js";
import {
  checkAnalysis,
  checkFeeling,
  checkRetro,
  type FixtureVerdict,
} from "../services/eval/m1-validators.js";
import {
  getFeelingExtractPrompt,
  getPostRunAnalysisPrompt,
  getRetroProposalPrompt,
} from "../router/prompts.js";

const PASS_THRESHOLD = 0.8;

async function call(system: string, user: string, model: string): Promise<string> {
  const provider = getProvider();
  const res = await provider.callText({ model, system, user, maxTokens: 700, temperature: 0.3, cacheSystem: true });
  return res.text;
}

async function runAnalysis(): Promise<FixtureVerdict[]> {
  const out: FixtureVerdict[] = [];
  for (const fx of ANALYSIS_FIXTURES) {
    const user =
      `# Objective stats (pre-computed — do not recompute)\n${JSON.stringify(fx.objective)}\n\n` +
      `# Discipline\nrun${fx.longRun ? " (long run)" : ""}\n\n` +
      `# Planned session today: ${fx.plannedType ?? "(unknown / unscheduled)"}\n\n` +
      `# Task\nWrite the coach's read of this run (1-2 sentences, plain text, no question).`;
    out.push(checkAnalysis(await call(getPostRunAnalysisPrompt(), user, config.llm.domainModel), fx));
  }
  return out;
}

async function runFeeling(): Promise<FixtureVerdict[]> {
  const out: FixtureVerdict[] = [];
  for (const fx of FEELING_FIXTURES) {
    const user =
      `# Most recent run (objective read)\n${fx.objectiveJson ?? "(no analysis yet)"}\n\n` +
      `# Runner's message\n${fx.message}`;
    out.push(checkFeeling(await call(getFeelingExtractPrompt(), user, config.llm.binderModel), fx));
  }
  return out;
}

async function runRetro(): Promise<FixtureVerdict[]> {
  const out: FixtureVerdict[] = [];
  for (const fx of RETRO_FIXTURES) {
    const user =
      `# Current plan\n${fx.planContext}\n\n` +
      `# This week's signals\n${fx.signalsJson}\n\n` +
      `# Per-run reads this week\n${fx.reads}\n\n` +
      `# Open flags\n${fx.flags}\n\n` +
      `# Trigger\n${fx.trigger} (week of 2026-06-08)\n\n` +
      `# Task\nDecide whether to adjust the plan. Return ONLY the JSON described in your instructions.`;
    out.push(checkRetro(await call(getRetroProposalPrompt(), user, config.llm.domainModel), fx));
  }
  return out;
}

function format(group: string, vs: FixtureVerdict[]): string {
  const lines = [`\n## ${group}`];
  for (const v of vs) {
    lines.push(`[${v.pass ? "PASS" : "FAIL"}] ${v.fixture}`);
    for (const c of v.checks) lines.push(`  ${c.pass ? "✓" : "✗"} ${c.id.padEnd(18)} ${c.detail}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  console.log("M1 coaching-loop eval");
  console.log(`Models: analysis/retro=${config.llm.domainModel}, feeling=${config.llm.binderModel}`);
  const groups: Array<[string, FixtureVerdict[]]> = [
    ["post-run-analysis", await runAnalysis()],
    ["feeling-extract", await runFeeling()],
    ["retro-proposal", await runRetro()],
  ];
  for (const [name, vs] of groups) console.log(format(name, vs));

  const all = groups.flatMap(([, vs]) => vs);
  const passed = all.filter((v) => v.pass).length;
  const rate = passed / all.length;
  console.log(`\n=== Summary ===\nPassed: ${passed}/${all.length} (${(rate * 100).toFixed(0)}%) | threshold ≥${PASS_THRESHOLD * 100}%`);
  if (rate < PASS_THRESHOLD) {
    console.log("FAIL — pass rate below threshold");
    process.exit(1);
  }
  console.log("PASS — eval green");
  process.exit(0);
}

main().catch((err) => {
  console.error("eval-m1: fatal error:", err);
  process.exit(2);
});
