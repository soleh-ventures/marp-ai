import { classify } from "./classifier.js";
import { runDomain } from "./domain.js";
import { synthesize } from "./synthesizer.js";
import type { RouterInput, RouterResult } from "./types.js";

// 2-call default, 3-call escalate (E2). For multi-domain queries we fan
// out domain calls in parallel since they're independent — saves latency
// the runner waits for.
export async function route(input: RouterInput): Promise<RouterResult> {
  const ctx = {
    athleteId: input.athleteId,
    messageId: input.messageId,
  };

  const routing = await classify(input.message, ctx);

  const domainAnswers = await Promise.all(
    routing.domains.map((d) =>
      runDomain(d, input.message, {
        ...ctx,
        contextSummary: input.contextSummary,
      }),
    ),
  );

  let finalText: string;
  let llmCallCount: number;
  if (domainAnswers.length === 1) {
    // Single-domain: the domain answer IS the final reply, no synthesizer.
    finalText = domainAnswers[0]?.text ?? "";
    llmCallCount = 2; // classifier + 1 domain
  } else {
    finalText = await synthesize(input.message, domainAnswers, ctx);
    llmCallCount = 1 + domainAnswers.length + 1; // classifier + N domain + synth
  }

  return { routing, domainAnswers, finalText, llmCallCount };
}

export type { RouterInput, RouterResult } from "./types.js";
