// Adaptive read of a runner's reply at the post-onboarding plan pivot.
//
// The pivot moment ("do you already have a plan (a), or should I build one
// (b)?") used to be decided by a brittle keyword classifier + canned replies.
// That mis-read "(B) but my first day…" as option (a) (the word "first" tripped
// an ordinal heuristic) and then trapped the runner re-emitting the same canned
// "paste your plan" line forever. See post-onboarding-pivot.ts history.
//
// This reads intent with an LLM instead, so MARP adapts to any phrasing like a
// coach would. A literal "a"/"b" tap still short-circuits to a deterministic
// answer (no model call, no latency) — see fastPathChoice. Everything else goes
// through classifyPivotIntent.

import { config } from "../config.js";
import { getPivotIntentPrompt } from "../router/prompts.js";
import { llmCall } from "./llm-call.js";
import { classifyPivotReply } from "./post-onboarding-pivot.js";

export type PivotIntent = "byo" | "build" | "plan_content" | "question";

export type PivotIntentResult = {
  intent: PivotIntent;
  // A natural, coach-voice acknowledgement — populated ONLY for `byo` (the
  // "great, paste it" turn). Null for every other intent; those paths produce
  // their own reply (build → plan summary, question → expert router, etc.).
  reply: string | null;
};

// "choice" — the runner was just asked (a)/(b).
// "awaiting_plan" — the runner already chose BYO and we're waiting for the
//   paste; here a reply might be the plan, a question, or a change of mind to
//   build.
export type PivotPhase = "choice" | "awaiting_plan";

// Deterministic fast-path: a bare option tap ("a", "b", "(b)", "b."). Returns
// null the moment the message carries anything beyond the decorated letter, so
// natural language ("b but my first day…") falls through to the LLM read rather
// than being force-matched. Intentionally narrower than classifyPivotReply:
// this is only the zero-ambiguity tap.
export function fastPathChoice(body: string): "byo" | "build" | null {
  const m = body.trim().match(/^\(?([ab])\)?[.)\s]*$/i);
  if (!m) return null;
  const letter = (m[1] ?? "").toLowerCase();
  if (letter === "a") return "byo";
  if (letter === "b") return "build";
  return null;
}

// Conservative deterministic fallback when the LLM read fails. Never throws,
// never traps: maps a clear keyword choice, otherwise leans on the phase.
function fallbackIntent(body: string, phase: PivotPhase): PivotIntent {
  const choice = classifyPivotReply(body);
  if (choice === "byo") return "byo";
  if (choice === "build") return "build";
  // No clear choice. In the choice phase, route onward as a question so the
  // runner is never trapped. While awaiting the paste, assume the message is
  // the plan content (the pre-existing behaviour) so a real paste still lands.
  return phase === "awaiting_plan" ? "plan_content" : "question";
}

function parseIntent(raw: string): PivotIntentResult | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const intent = (obj as Record<string, unknown>).intent;
  if (
    intent !== "byo" &&
    intent !== "build" &&
    intent !== "plan_content" &&
    intent !== "question"
  ) {
    return null;
  }
  const replyRaw = (obj as Record<string, unknown>).reply;
  const reply =
    intent === "byo" && typeof replyRaw === "string" && replyRaw.trim().length > 0
      ? replyRaw.trim()
      : null;
  return { intent, reply };
}

export async function classifyPivotIntent(input: {
  body: string;
  phase: PivotPhase;
  athleteId: string;
  messageId: string | null;
}): Promise<PivotIntentResult> {
  const phaseNote =
    input.phase === "awaiting_plan"
      ? "Context: the runner already chose to bring their own plan and was asked to paste it. Their next message may be the plan itself (plan_content), a question, or a change of mind to have you build one instead (build)."
      : "Context: the runner was just asked whether they already have a plan (a) or want one built (b). Decide which path they mean.";
  const user = `${phaseNote}\n\n# Runner's message\n${input.body}`;

  try {
    const res = await llmCall(
      {
        model: config.llm.classifierModel,
        system: getPivotIntentPrompt(),
        user,
        maxTokens: 200,
        temperature: 0,
        cacheSystem: true,
      },
      { athleteId: input.athleteId, messageId: input.messageId ?? undefined, component: "classifier" },
    );
    const parsed = parseIntent(res.text);
    if (parsed) return parsed;
  } catch (err) {
    console.error("pivot-intent: LLM read failed:", (err as Error).message);
  }
  return { intent: fallbackIntent(input.body, input.phase), reply: null };
}
