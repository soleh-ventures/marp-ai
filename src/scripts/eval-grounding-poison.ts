#!/usr/bin/env bun
/**
 * KER-77 (Grounded Coach, Phase 0 de-risk) — location-poisoning eval.
 *
 * Settles the plan's load-bearing question: does a correct DB SSOT alone
 * stop the location hallucination, or does the stale claim in the
 * un-strippable message log still poison the answer?
 *
 * Method: for each fixture, build a PRODUCTION-FAITHFUL runner context
 * (ground truth = Berlin, a stale "Tokyo" claim planted in the recent
 * messages exactly as formatContext dumps them), wrap it the way
 * runDomain does, ask the real domain LLM where the runner lives, and
 * grade the answer Berlin (grounded) / Tokyo (poisoned) / unclear.
 *
 * Usage: bun run eval:grounding
 *
 * Cost: one domain (Sonnet) call per fixture (~10) — a few cents.
 *
 * Reading the result:
 *   - poisoned > 0 on "clear" fixtures → the column alone is NOT enough;
 *     Phase 1 must also restate the resolved value in the ground-truth
 *     line and/or down-weight superseded claims in the message log, and
 *     lean on the deterministic readback. (This is the expected outcome.)
 *   - poisoned == 0 → the existing soft instruction already holds; Phase 1
 *     can lean on the SSOT + JSON-strip alone. (Unlikely.)
 */

import { runDomain } from "../router/domain.js";
import { POISON_FIXTURES, type PoisonFixture } from "../services/grounding/poison-fixtures.js";

type Grade = "grounded" | "poisoned" | "unclear";

function grade(answer: string, fx: PoisonFixture): Grade {
  const a = answer.toLowerCase();
  const saysHome = a.includes(fx.home.toLowerCase());
  const saysPoison = a.includes(fx.poison.toLowerCase());
  if (saysHome && !saysPoison) return "grounded";
  if (saysPoison && !saysHome) return "poisoned";
  return "unclear"; // both, neither, or hedged
}

async function main(): Promise<void> {
  console.log("KER-77 grounding-poison eval (ground truth = Berlin)\n");

  let clearPoisoned = 0;
  let clearTotal = 0;
  let ambiguousPoisoned = 0;
  const rows: string[] = [];

  for (const fx of POISON_FIXTURES) {
    const res = await runDomain("training", fx.question, {
      contextSummary: fx.context,
    });
    const g = grade(res.text, fx);
    if (fx.kind === "clear") {
      clearTotal++;
      if (g === "poisoned") clearPoisoned++;
    } else if (g === "poisoned") {
      ambiguousPoisoned++;
    }
    const mark = g === "grounded" ? "✓" : g === "poisoned" ? "✗ POISONED" : "~ unclear";
    rows.push(
      `${fx.name.padEnd(26)} [${fx.kind.padEnd(9)}] ${mark}  — "${res.text.replace(/\s+/g, " ").slice(0, 80)}"`,
    );
  }

  for (const r of rows) console.log(r);

  const rate = clearTotal > 0 ? clearPoisoned / clearTotal : 0;
  console.log("\n=== Summary ===");
  console.log(`Clear fixtures poisoned (said Tokyo): ${clearPoisoned}/${clearTotal} (${(rate * 100).toFixed(0)}%)`);
  console.log(`Ambiguous (current-trip) poisoned: ${ambiguousPoisoned} (informational)`);
  console.log("");
  if (clearPoisoned > 0) {
    console.log(
      "VERDICT: DB SSOT alone is NOT sufficient — the stale message-log claim still poisons " +
        `${clearPoisoned} clear case(s). Phase 1 MUST restate the resolved value in the ` +
        "ground-truth line + add the deterministic readback (KER-78 scope confirmed).",
    );
  } else {
    console.log(
      "VERDICT: no poisoning on clear cases — the existing soft instruction holds; Phase 1 " +
        "can lean on SSOT + JSON-strip. (Re-check after any prompt change.)",
    );
  }
  // This is a measurement, not a CI gate — always exit 0.
  process.exit(0);
}

main().catch((err) => {
  console.error("eval-grounding-poison: fatal error:", err);
  process.exit(2);
});
