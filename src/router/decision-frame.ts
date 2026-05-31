import type { DecisionFrame, DecisionFrameOption } from "./types.js";

// ET6: shared decision_frame extraction used by both domain and synth.
//
// Wire format (LLM-emitted): the natural-language reply ends with a
// fenced block tagged <decision_frame>...</decision_frame>. The block
// body is strict JSON. Example:
//
//   You're tired and have a tempo on the plan. Two reasonable paths:
//
//   <decision_frame>{"question":"Tempo or swap to easy?","options":[
//     {"key":"tempo","label":"Run the tempo as planned","action_hint":"if HR settles in warmup"},
//     {"key":"easy","label":"Swap to 30min easy"},
//     {"key":"rest","label":"Take it as a full rest day"}
//   ]}</decision_frame>
//
// Why an in-band marker rather than a separate LLM call:
// - 1 LLM call instead of 2 → cheaper + lower latency
// - Atomic — the frame matches the natural-language version exactly
//   because the same model wrote both in the same generation
//
// Why a custom tag rather than a Markdown code fence:
// - The runner never sees the JSON (we strip the entire block before
//   sending) so it doesn't need to be "valid" Markdown
// - Tags are easier to match unambiguously than fenced blocks that the
//   LLM might or might not label "```json"
//
// Robustness notes:
// - Any whitespace allowed inside the tag
// - The block must be the LAST thing in the reply — if the LLM puts
//   text after </decision_frame>, we drop that text too (the natural
//   reply is everything before the opening tag)
// - JSON parse failure → return null + the original text minus the
//   block (so the runner sees the natural answer even if structure
//   broke). One-shot retry is owned by the caller (router/index.ts).

const FRAME_TAG_REGEX =
  /<decision_frame>\s*([\s\S]*?)\s*<\/decision_frame>\s*$/i;

export type FrameExtractionResult = {
  // Reply text with the decision_frame block stripped — what the runner sees.
  text: string;
  // Parsed frame, or null when no block was present / parse failed.
  frame: DecisionFrame | null;
  // True iff a <decision_frame> block was present but failed to parse.
  // Caller uses this to decide whether to fire a one-shot retry.
  parseFailed: boolean;
};

export function extractDecisionFrame(raw: string): FrameExtractionResult {
  const match = raw.match(FRAME_TAG_REGEX);
  if (!match) {
    return { text: raw.trim(), frame: null, parseFailed: false };
  }
  // Strip the tag (and anything after) from the natural-language reply.
  const text = raw.slice(0, match.index).trim();
  const jsonBody = match[1] ?? "";
  try {
    const parsed = JSON.parse(jsonBody);
    const frame = validateFrame(parsed);
    if (!frame) {
      return { text, frame: null, parseFailed: true };
    }
    return { text, frame, parseFailed: false };
  } catch {
    return { text, frame: null, parseFailed: true };
  }
}

function validateFrame(value: unknown): DecisionFrame | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.question !== "string" || obj.question.length === 0) {
    return null;
  }
  if (!Array.isArray(obj.options) || obj.options.length === 0) {
    return null;
  }
  const options: DecisionFrameOption[] = [];
  for (const raw of obj.options) {
    if (!raw || typeof raw !== "object") return null;
    const opt = raw as Record<string, unknown>;
    if (typeof opt.key !== "string" || opt.key.length === 0) return null;
    if (typeof opt.label !== "string" || opt.label.length === 0) return null;
    const item: DecisionFrameOption = { key: opt.key, label: opt.label };
    if (typeof opt.action_hint === "string" && opt.action_hint.length > 0) {
      item.action_hint = opt.action_hint;
    }
    options.push(item);
  }
  // Option keys must be unique — that's what the binder matches on.
  const seen = new Set<string>();
  for (const o of options) {
    if (seen.has(o.key)) return null;
    seen.add(o.key);
  }
  return { question: obj.question, options };
}
