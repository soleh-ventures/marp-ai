import { config } from "../config.js";
import { llmCall } from "../services/llm-call.js";
import { extractDecisionFrame } from "./decision-frame.js";
import { getDomainPrompt } from "./prompts.js";
import type { Domain, DomainAnswer } from "./types.js";

export type RunDomainContext = {
  athleteId?: string;
  messageId?: string;
  contextSummary?: string;
  // ET6: when the classifier flagged is_fork, the runner expects a
  // choice. We pass that signal through so the domain prompt can decide
  // whether to append a <decision_frame> block.
  isFork?: boolean;
};

export async function runDomain(
  domain: Domain,
  message: string,
  ctx: RunDomainContext,
): Promise<DomainAnswer> {
  // Always wrap the message in a structured payload, even when context is
  // empty. Gives the domain prompt a consistent shape and lets memory
  // (T7) drop in a context block without changing the message section.
  const contextBlock = ctx.contextSummary
    ? `# Runner context\n${ctx.contextSummary}\n\n`
    : "";
  // ET6: surface is_fork to the domain prompt. The prompt itself decides
  // what to do with it (training.md emits a frame; other domains can
  // ignore for now).
  const forkBlock = ctx.isFork ? "# Fork requested\ntrue\n\n" : "";
  const userPayload = `${contextBlock}${forkBlock}# Message\n${message}`;

  const res = await llmCall(
    {
      model: config.llm.domainModel,
      system: getDomainPrompt(domain),
      user: userPayload,
      maxTokens: 1500,
      temperature: 0.5,
      cacheSystem: true,
    },
    { athleteId: ctx.athleteId, messageId: ctx.messageId, component: "domain" },
  );
  const extracted = extractDecisionFrame(res.text);
  return {
    domain,
    text: extracted.text,
    ...(extracted.frame ? { frame: extracted.frame } : {}),
  };
}

// Exposed for testing the frame-extraction round-trip without a real LLM call.
export const _internal = { extractDecisionFrame };
