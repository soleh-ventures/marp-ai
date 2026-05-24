import { config } from "../config.js";
import { llmCall } from "../services/llm-call.js";
import type { Domain, DomainAnswer } from "./types.js";

// T6 replaces this with on-disk prompts/domains/{name}.md loaded once at
// boot. For T5 we ship a placeholder so the wiring is exercisable end to
// end — the placeholder is intentionally short and obviously a stub.
const STUB_PROMPTS: Record<Domain, string> = {
  training:
    "You are MARP's training coach. Reply concisely with concrete training advice. (T5 stub — replaced by prompts/domains/training.md in T6.)",
  nutrition:
    "You are MARP's nutrition expert. Reply concisely with practical fueling and hydration guidance. (T5 stub.)",
  injury:
    "You are MARP's injury triage expert. Use the 0-3 / 4-5 / 6+ pain ladder. Refer to a physio when warranted. (T5 stub.)",
  mental:
    "You are MARP's mental performance coach. Reply with grounded, non-saccharine support. (T5 stub.)",
  recovery:
    "You are MARP's recovery expert. Reply with sleep, mobility, and load-management advice. (T5 stub.)",
  gear:
    "You are MARP's gear advisor. Reply with shoe and equipment guidance grounded in the runner's profile. (T5 stub.)",
};

export function getDomainPrompt(domain: Domain): string {
  return STUB_PROMPTS[domain];
}

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
