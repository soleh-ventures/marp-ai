import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { messages, pendingDecisions } from "../db/schema.js";
import type {
  DecisionFrame,
  DecisionFrameOption,
} from "../router/types.js";
import { llmCall } from "./llm-call.js";
import { getOpenFrames } from "./pending-decisions.js";

// ET7 — the binder.
//
// The binder is the loop closer for MARP's decision frames. When the
// runner replies, the binder tries to match that reply to an open frame
// the LLM chain previously emitted. It writes the resolution in two
// places (atomic): pending_decisions.resolved_at + resolved_key, and
// messages.resolves_pending_decision_id on the inbound message.
//
// Two-stage match:
//
//   1. Exact / near-exact match against an option's key or label. Cheap,
//      deterministic, runs first. Covers the common case: runner sends
//      "rest" → option key "rest" → match.
//
//   2. LLM free-form match (LLM_BINDER_MODEL = Haiku 4.5 by default).
//      Only runs when step 1 produced no match and there's at least one
//      open frame. Strict prompt — instructed to return null when
//      uncertain. We trust null answers; false negatives are recoverable
//      (the frame stays open, runner can reclarify) but a false positive
//      silently breaks MARP's memory of the conversation.
//
// Ordering across multiple open frames:
//   Both stages walk frames newest-first. The newest open frame is the
//   most-likely target of a reply. We resolve at most ONE frame per call.
//
// Cost / latency:
//   - No open frames → 0 calls, 0 ms (early return)
//   - Exact match → 0 LLM calls (regex / string only)
//   - LLM fallback → 1 Haiku call (~300–500 ms, ~$0.0001)

const BINDER_PROMPT_PATH = "prompts/decision-binder.md";

export type BinderMatchedBy = "exact" | "llm";
export type BindResult =
  | {
      resolved: true;
      frameId: string;
      key: string;
      matchedBy: BinderMatchedBy;
    }
  | { resolved: false; reason?: "no_open_frames" | "no_match" };

export async function bindReply(
  athleteId: string,
  inboundMessageId: string,
  inboundBody: string,
): Promise<BindResult> {
  const openFrames = await getOpenFrames(athleteId);
  if (openFrames.length === 0) {
    return { resolved: false, reason: "no_open_frames" };
  }

  // ── Stage 1: exact / near-exact match across all open frames ──────────
  for (const row of openFrames) {
    const frame = row.frame as DecisionFrame;
    const exactKey = tryExactMatch(inboundBody, frame);
    if (exactKey) {
      await markResolved(row.id, exactKey, inboundMessageId);
      return {
        resolved: true,
        frameId: row.id,
        key: exactKey,
        matchedBy: "exact",
      };
    }
  }

  // ── Stage 2: LLM free-form match against the newest open frame ────────
  // We only consult the LLM on the newest frame to bound cost. Older
  // frames typically time out of relevance by the time the runner
  // sends ambiguous replies.
  const newest = openFrames[0];
  if (!newest) return { resolved: false, reason: "no_match" };
  const newestFrame = newest.frame as DecisionFrame;
  const llmKey = await tryLlmMatch(
    inboundBody,
    newestFrame,
    athleteId,
    inboundMessageId,
  );
  if (llmKey) {
    await markResolved(newest.id, llmKey, inboundMessageId);
    return {
      resolved: true,
      frameId: newest.id,
      key: llmKey,
      matchedBy: "llm",
    };
  }
  return { resolved: false, reason: "no_match" };
}

// Normalize a body / option string for comparison: lowercase, strip
// punctuation, collapse whitespace. Keys with underscores compare to
// space-separated forms.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Build the set of strings that count as an exact match for an option.
// Pulls in both the snake_case key (with _ → space) and the user-facing
// label. Optionally extends with simple variants like the label with
// trailing prepositions stripped, but keeping it minimal — anything
// fuzzier defers to the LLM stage.
function matchTokens(option: DecisionFrameOption): string[] {
  return [normalize(option.key), normalize(option.label)];
}

// Returns the option key when the body unambiguously matches exactly
// one option in the frame. "Unambiguously" = the body is one of the
// option tokens (case-insensitive, normalized), AND no other option's
// tokens also match the body. Multi-option matches return null to keep
// the false-positive bar high — let the LLM stage decide.
export function tryExactMatch(
  body: string,
  frame: DecisionFrame,
): string | null {
  const normBody = normalize(body);
  if (!normBody) return null;
  const hits: string[] = [];
  for (const option of frame.options) {
    const tokens = matchTokens(option);
    if (tokens.some((t) => t === normBody)) {
      hits.push(option.key);
    }
  }
  return hits.length === 1 ? hits[0]! : null;
}

// LLM stage. Uses LLM_BINDER_MODEL (Haiku by default) with a strict
// prompt that returns null when uncertain. Defensive parse — the LLM
// is instructed to return one-line JSON but we strip fences and prose
// the same way the classifier does.
async function tryLlmMatch(
  body: string,
  frame: DecisionFrame,
  athleteId: string,
  inboundMessageId: string,
): Promise<string | null> {
  const system = await getBinderPrompt();
  const optionsForPrompt = frame.options.map((o) => ({
    key: o.key,
    label: o.label,
    ...(o.action_hint ? { action_hint: o.action_hint } : {}),
  }));
  const userPayload =
    `# Question\n${frame.question}\n\n` +
    `# Options\n${JSON.stringify(optionsForPrompt)}\n\n` +
    `# Runner's reply\n${body}`;

  const res = await llmCall(
    {
      model: config.llm.binderModel,
      system,
      user: userPayload,
      maxTokens: 80,
      temperature: 0,
      cacheSystem: true,
    },
    {
      athleteId,
      messageId: inboundMessageId,
      component: "binder",
    },
  );

  const parsed = parseBinderJson(res.text);
  if (!parsed) return null;
  // Validate the LLM didn't invent an option that isn't in the frame.
  // Defends against subtle hallucinations the prompt rules can't fully prevent.
  const validKeys = new Set(frame.options.map((o) => o.key));
  if (parsed.key && validKeys.has(parsed.key)) {
    return parsed.key;
  }
  return null;
}

// Defensive JSON parse — same style as classifier.parseRouting.
export function parseBinderJson(
  raw: string,
): { key: string | null; reasoning?: string } | null {
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
  const o = obj as Record<string, unknown>;
  if (o.key === null) return { key: null };
  if (typeof o.key === "string" && o.key.length > 0) {
    return {
      key: o.key,
      ...(typeof o.reasoning === "string" ? { reasoning: o.reasoning } : {}),
    };
  }
  return null;
}

async function markResolved(
  frameId: string,
  resolvedKey: string,
  inboundMessageId: string,
): Promise<void> {
  // Wrap both writes so a partial failure leaves nothing half-resolved.
  // The pending_decisions row + the message back-pointer must agree.
  await db.transaction(async (tx) => {
    await tx
      .update(pendingDecisions)
      .set({ resolvedAt: new Date(), resolvedKey })
      .where(eq(pendingDecisions.id, frameId));
    await tx
      .update(messages)
      .set({ resolvesPendingDecisionId: frameId })
      .where(eq(messages.id, inboundMessageId));
  });
}

// Cached prompt body — read once at first call. We don't need the
// frontmatter parser used by the router prompts because the binder
// prompt is a single LLM persona with no per-domain fan-out.
let cachedBinderPrompt: string | null = null;
async function getBinderPrompt(): Promise<string> {
  if (cachedBinderPrompt) return cachedBinderPrompt;
  const raw = await readFile(
    join(process.cwd(), BINDER_PROMPT_PATH),
    "utf-8",
  );
  // Strip the frontmatter block — the LLM doesn't need it.
  cachedBinderPrompt = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
  return cachedBinderPrompt;
}

// Test-only: reset the prompt cache so a freshly-edited prompt.md
// reloads. Production code never calls this.
export function _resetBinderPromptCache(): void {
  cachedBinderPrompt = null;
}
