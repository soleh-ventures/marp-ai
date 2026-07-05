#!/usr/bin/env bun
/**
 * V10 — Plan-generator eval runner.
 *
 * Runs the live plan generator against each fixture profile and checks
 * the output with rule-based validators. Prints per-fixture verdict to
 * stdout. Exits 0 if pass rate ≥ 80%, else 1.
 *
 * Usage:
 *   bun run eval:plan
 *
 * Cost: one Sonnet call per fixture (~5k tokens out × 5 fixtures =
 * roughly $0.20–0.30 per full run). Not in CI — operator triggers on
 * prompt/model changes.
 *
 * Bypasses llmCall() to avoid polluting llm_calls with eval rows, but
 * uses the same provider + system prompt the production path uses.
 */

import { config } from "../config.js";
import { getProvider } from "../services/llm/index.js";
import { parsePlanResponse } from "../services/plan/generator.js";
import { FIXTURES, type PlanFixture } from "../services/plan/eval/fixtures.js";
import { runChecks, type FixtureResult } from "../services/plan/eval/validators.js";
import { getPlanGeneratorPrompt } from "../router/prompts.js";

const PASS_THRESHOLD = 0.8;

async function evaluateFixture(fixture: PlanFixture): Promise<FixtureResult> {
  const today = new Date().toISOString().slice(0, 10);
  const userPayload =
    `# Today's date\n${today}\n\n` +
    `# Athlete context\n${fixture.memoryText}\n\n` +
    `# Task\nBuild a complete periodised plan for this runner. Return ONLY the JSON described in your instructions — no markdown, no commentary.`;

  const provider = getProvider();
  const res = await provider.callText({
    model: config.llm.domainModel,
    system: getPlanGeneratorPrompt(),
    user: userPayload,
    // Must match production (plan/generator.ts:63). This sat at 4000 while
    // prod ran 16000 — the longer v0.9.0 plans truncated mid-JSON and every
    // fixture failed on "Expected ']'" while prod was fine.
    maxTokens: 16000,
    temperature: 0.4,
    cacheSystem: true,
  });

  try {
    const plan = parsePlanResponse(res.text);
    return runChecks(plan, fixture);
  } catch (err) {
    return {
      fixture: fixture.name,
      pass: false,
      checks: [
        {
          id: "structure",
          pass: false,
          detail: `parse failed: ${(err as Error).message}`,
        },
      ],
    };
  }
}

function formatResult(r: FixtureResult): string {
  const lines: string[] = [];
  const verdict = r.pass ? "PASS" : "FAIL";
  const passingCount = r.checks.filter((c) => c.pass).length;
  lines.push(`\n[${verdict}] ${r.fixture} — ${passingCount}/${r.checks.length} checks`);
  for (const c of r.checks) {
    const mark = c.pass ? "✓" : "✗";
    lines.push(`  ${mark} ${c.id.padEnd(22)} ${c.detail}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  console.log("V10 plan-generator eval");
  console.log(`Model: ${config.llm.domainModel}`);
  console.log(`Fixtures: ${FIXTURES.length}`);
  console.log(`Pass threshold: ≥${PASS_THRESHOLD * 100}% of fixtures pass overall`);
  console.log("");

  const results: FixtureResult[] = [];
  for (const fixture of FIXTURES) {
    process.stdout.write(`Running ${fixture.name}... `);
    const t0 = Date.now();
    try {
      const r = await evaluateFixture(fixture);
      results.push(r);
      process.stdout.write(`${Date.now() - t0}ms\n`);
    } catch (err) {
      process.stdout.write(`ERROR\n`);
      console.error(`  ${(err as Error).message}`);
      results.push({
        fixture: fixture.name,
        pass: false,
        checks: [
          {
            id: "structure",
            pass: false,
            detail: `runtime error: ${(err as Error).message}`,
          },
        ],
      });
    }
  }

  console.log("\n=== Results ===");
  for (const r of results) {
    console.log(formatResult(r));
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const rate = passed / total;
  console.log("\n=== Summary ===");
  console.log(`Passed: ${passed}/${total} (${(rate * 100).toFixed(0)}%)`);
  console.log(`Threshold: ≥${PASS_THRESHOLD * 100}%`);

  if (rate < PASS_THRESHOLD) {
    console.log("\nFAIL — pass rate below threshold");
    process.exit(1);
  }
  console.log("\nPASS — eval green");
  process.exit(0);
}

main().catch((err) => {
  console.error("eval-plan: fatal error:", err);
  process.exit(2);
});
