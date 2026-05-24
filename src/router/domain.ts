import { config } from "../config.js";
import { llmCall } from "../services/llm-call.js";
import { getDomainPrompt } from "./prompts.js";
import type { Domain, DomainAnswer } from "./types.js";

export async function runDomain(
  domain: Domain,
  message: string,
  ctx: {
    athleteId?: string;
    messageId?: string;
    contextSummary?: string;
  },
): Promise<DomainAnswer> {
  // Always wrap the message in a structured payload, even when context is
  // empty. Gives the domain prompt a consistent shape and lets memory
  // (T7) drop in a context block without changing the message section.
  const contextBlock = ctx.contextSummary
    ? `# Runner context\n${ctx.contextSummary}\n\n`
    : "";
  const userPayload = `${contextBlock}# Message\n${message}`;

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
  return { domain, text: res.text };
}
