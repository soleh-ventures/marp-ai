#!/usr/bin/env bun
/**
 * Persona golden-transcript eval — the settings-theater guard.
 *
 * The onboarding revamp lets an athlete pick a coaching relationship
 * (Director/Partner/Companion) and a default reply length (short/balanced/
 * long). If those choices don't OBSERVABLY change the coach's replies, the
 * preference questions are theater and trust drops more than if we'd never
 * asked. This eval renders the same athlete messages under every calibration
 * and checks the transcripts differentiate.
 *
 * Pass bars:
 *   1. Blind-match (relationship): an LLM judge shown the three style
 *      transcripts UNLABELED must match each to its style. >= 80% correct.
 *   2. Length ordering: for the same message, short-default replies must be
 *      shorter than long-default replies (word count, per message pair).
 *   3. THE OVERRIDE CASE (required by the final-gate decision): an athlete
 *      with reply_style=short who EXPLICITLY asks "explain in detail why"
 *      must get a LONG answer (>= 120 words). A short answer here is the
 *      trust-breaking bug this eval exists to catch — it fails the run.
 *
 * Usage:  bun run eval:persona    (requires ANTHROPIC_API_KEY; ~30 calls)
 * Not in CI — operator-triggered on prompt/calibration changes.
 */

import { config } from "../config.js";
import { getProvider } from "../services/llm/index.js";
import { getSynthesizerPrompt } from "../router/prompts.js";
import { renderCoachCalibration } from "../memory/retrieve.js";

type Style = "director" | "partner" | "companion";
type Len = "short" | "balanced" | "long";

const STYLES: Style[] = ["director", "partner", "companion"];

// Fixed athlete messages — each one gives the persona room to show.
const MESSAGES = [
  "I skipped my tempo run yesterday, just wasn't feeling it. Should I make it up today?",
  "My long run felt terrible, legs were dead the whole time. What's going on?",
  "I want to add a fifth running day. Thoughts?",
];

const OVERRIDE_MESSAGE =
  "explain in detail why this week has a tempo run at all — walk me through the reasoning";

const EXPERT_CONTEXT =
  "1. [training] The skipped tempo shouldn't be made up — fold it into the week; " +
  "back-to-back quality risks the knee. Next quality day is Thursday.";

function contextFor(style: Style, len: Len): string {
  const calibration = renderCoachCalibration({
    coach_prefs: { coaching_style: style, reply_style: len },
  });
  return (
    `Athlete: Kemal (locale en)\n${calibration}\n` +
    "Goal (ground truth): 1:45:00 at Berlin Half (half marathon).\n" +
    "Athletic history: {\"training_days_per_week\":4,\"current_injuries\":[\"left knee — occasional\"]}"
  );
}

async function synthReply(style: Style, len: Len, message: string): Promise<string> {
  const provider = getProvider();
  const res = await provider.callText({
    model: config.llm.synthesizerModel,
    system: getSynthesizerPrompt(),
    user:
      `# Runner's message\n${message}\n\n# Athlete context\n${contextFor(style, len)}\n\n` +
      `# Expert answers\n${EXPERT_CONTEXT}\n\nFork requested: false`,
    maxTokens: 700,
    temperature: 0,
  });
  return res.text.trim();
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

async function blindJudge(transcripts: Record<Style, string[]>): Promise<number> {
  const provider = getProvider();
  // Shuffle deterministically: present as A/B/C in fixed order but ask the
  // judge to assign labels.
  const blocks = STYLES.map(
    (s, i) => `## Transcript ${"ABC"[i]}\n${transcripts[s].join("\n---\n")}`,
  ).join("\n\n");
  const res = await provider.callText({
    model: config.llm.classifierModel,
    system:
      "You judge coaching transcripts. Three coaching relationships exist:\n" +
      "- director: makes the calls, pushes, no hand-holding\n" +
      "- partner: decides together, direct but encouraging\n" +
      "- companion: warm friend, supportive, patient\n" +
      'Reply STRICT JSON: {"A": "<style>", "B": "<style>", "C": "<style>"}',
    user: blocks,
    maxTokens: 100,
    temperature: 0,
  });
  const m = res.text.match(/\{[\s\S]*\}/);
  if (!m) return 0;
  const judged = JSON.parse(m[0]) as Record<string, string>;
  let correct = 0;
  STYLES.forEach((s, i) => {
    if (judged["ABC"[i]!] === s) correct++;
  });
  return correct / STYLES.length;
}

async function main() {
  if (config.llm.provider === "mock") {
    console.error("eval:persona needs the live provider (LLM_PROVIDER=anthropic).");
    process.exit(2);
  }

  console.log("Persona golden-transcript eval\n==============================");

  // 1. Relationship transcripts (balanced length, style varies).
  const transcripts: Record<Style, string[]> = { director: [], partner: [], companion: [] };
  for (const style of STYLES) {
    for (const msg of MESSAGES) {
      transcripts[style].push(await synthReply(style, "balanced", msg));
    }
  }
  const matchRate = await blindJudge(transcripts);
  console.log(`\nBlind-match rate: ${(matchRate * 100).toFixed(0)}% (bar: 80%)`);

  // 2. Length ordering (partner style, length varies).
  let orderingOk = 0;
  for (const msg of MESSAGES) {
    const short = words(await synthReply("partner", "short", msg));
    const long = words(await synthReply("partner", "long", msg));
    const ok = short < long;
    console.log(`Length pair "${msg.slice(0, 40)}…": short=${short}w long=${long}w ${ok ? "✓" : "✗"}`);
    if (ok) orderingOk++;
  }

  // 3. The override case — short default, explicit request for detail.
  const overrideReply = await synthReply("partner", "short", OVERRIDE_MESSAGE);
  const overrideWords = words(overrideReply);
  const overrideOk = overrideWords >= 120;
  console.log(
    `\nOverride case (short default + "explain in detail"): ${overrideWords} words ` +
      `(bar: >=120) ${overrideOk ? "✓" : "✗ TRUST-BREAKING BUG"}`,
  );

  const pass = matchRate >= 0.8 && orderingOk === MESSAGES.length && overrideOk;
  console.log(`\n${pass ? "PASS" : "FAIL"} — persona ${pass ? "differentiates observably" : "is settings theater; fix prompts before shipping the questions"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("eval:persona crashed:", err);
  process.exit(2);
});
