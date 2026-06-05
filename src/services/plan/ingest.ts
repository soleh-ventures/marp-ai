// V6 (v1.1 flow redesign) — plan ingest.
//
// LLM-driven parse of pasted training plan text into the canonical
// Plan jsonb. Returns either a Plan or a structured error so the
// caller can send a friendly "couldn't parse" reply instead of
// throwing into the runner's chat.
//
// The LLM is instructed to emit `{ "error": "not_a_plan", "message": ... }`
// when the pasted text doesn't look like a training plan (recipe,
// question, random text). That short-circuits the parsePlan call.

import { config } from "../../config.js";
import { getMemoryContext } from "../../memory/retrieve.js";
import { getPlanIngestPrompt } from "../../router/prompts.js";
import { llmCall } from "../llm-call.js";
import { parsePlan, type Plan } from "./types.js";

export type IngestPlanInput = {
  athleteId: string;
  messageId: string;
  pastedText: string;
};

export type IngestPlanResult =
  | { ok: true; plan: Plan }
  | { ok: false; reason: "not_a_plan"; message: string }
  | { ok: false; reason: "parse_failed"; message: string };

export async function ingestPlan(input: IngestPlanInput): Promise<IngestPlanResult> {
  const memory = await getMemoryContext(input.athleteId);

  const today = new Date().toISOString().slice(0, 10);
  const userPayload =
    `# Today's date\n${today}\n\n` +
    `# Athlete context\n${memory.text}\n\n` +
    `# Plan pasted by the runner\n${input.pastedText}\n\n` +
    `# Task\nParse the pasted plan into the JSON described in your instructions. Return ONLY the JSON — no markdown, no commentary.`;

  const res = await llmCall(
    {
      model: config.llm.domainModel,
      system: getPlanIngestPrompt(),
      user: userPayload,
      maxTokens: 4000,
      temperature: 0.2,
      cacheSystem: true,
    },
    { athleteId: input.athleteId, messageId: input.messageId, component: "domain" },
  );

  return parseIngestResponse(res.text);
}

export function parseIngestResponse(raw: string): IngestPlanResult {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      ok: false,
      reason: "parse_failed",
      message: `non-JSON response: ${raw.slice(0, 200)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    return {
      ok: false,
      reason: "parse_failed",
      message: (err as Error).message,
    };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj.error === "not_a_plan") {
      const msg = typeof obj.message === "string" ? obj.message : "doesn't look like a plan";
      return { ok: false, reason: "not_a_plan", message: msg };
    }
  }
  try {
    const plan: Plan = parsePlan(parsed);
    return { ok: true, plan };
  } catch (err) {
    return {
      ok: false,
      reason: "parse_failed",
      message: (err as Error).message,
    };
  }
}
