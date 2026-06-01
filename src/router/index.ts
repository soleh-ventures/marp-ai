import { classify } from "./classifier.js";
import { runDomain } from "./domain.js";
import { synthesize } from "./synthesizer.js";
import type { DecisionFrame, RouterInput, RouterResult } from "./types.js";

// 2-call default, 3-call escalate (E2). For multi-domain queries we fan
// out domain calls in parallel since they're independent — saves latency
// the runner waits for.
//
// ET6 additions:
// - Classifier's is_fork flows through to domain/synthesizer so they
//   can emit a <decision_frame> block when the reply presents options.
// - We surface the parsed frame in RouterResult so process-incoming can
//   persist it into pending_decisions for the binder to resolve later.
// - One-shot retry on a failed frame parse: caller's prompt-discipline
//   improves under retry far more often than not. We bound it at 1 to
//   keep latency / cost predictable.
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
        isFork: routing.isFork,
      }),
    ),
  );

  let finalText: string;
  let frame: DecisionFrame | null;
  let llmCallCount: number;
  if (domainAnswers.length === 1) {
    // Single-domain: the domain answer IS the final reply, no synthesizer.
    const only = domainAnswers[0];
    finalText = only?.text ?? "";
    frame = only?.frame ?? null;
    llmCallCount = 2; // classifier + 1 domain

    // One-shot retry: classifier said is_fork=true but no domain frame
    // came back. Re-ask the same domain with an explicit hint. Bounded
    // to a single retry to keep latency / cost predictable.
    if (routing.isFork && !frame && only) {
      const retry = await runDomain(only.domain, input.message, {
        ...ctx,
        contextSummary: input.contextSummary,
        isFork: true,
      });
      llmCallCount += 1;
      if (retry.frame) {
        finalText = retry.text;
        frame = retry.frame;
      }
    }
  } else {
    const synthResult = await synthesize(input.message, domainAnswers, {
      ...ctx,
      isFork: routing.isFork,
    });
    finalText = synthResult.text;
    frame = synthResult.frame;
    llmCallCount = 1 + domainAnswers.length + 1; // classifier + N domain + synth

    // Same one-shot retry pattern at the synth layer.
    if (routing.isFork && !frame) {
      const retry = await synthesize(input.message, domainAnswers, {
        ...ctx,
        isFork: true,
      });
      llmCallCount += 1;
      if (retry.frame) {
        finalText = retry.text;
        frame = retry.frame;
      }
    }
  }

  return { routing, domainAnswers, finalText, frame, llmCallCount };
}

export type { RouterInput, RouterResult } from "./types.js";
