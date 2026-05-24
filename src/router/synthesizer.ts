import { config } from "../config.js";
import { llmCall } from "../services/llm-call.js";
import type { DomainAnswer } from "./types.js";

// The synthesizer only runs when the classifier picked >1 domain. It's the
// single point where multiple expert voices become one MARP voice. Goal:
// no contradictions, no "as the X expert said, and as the Y expert said"
// stitching — one coherent reply.
const SYSTEM = `You are MARP synthesizing multiple expert answers into one
reply for the runner.

You will receive:
1. The runner's original message
2. Numbered answers from MARP's domain experts who each looked at the
   message from their angle

Your job:
- Produce ONE reply in MARP's voice
- Reconcile any contradictions (favour the more conservative answer on
  injury vs training conflicts)
- Do not name the experts ("the training coach says...") — speak as MARP
- Keep total length under 250 words unless the question genuinely needs
  more
- If experts agree, don't repeat each agreement — say it once
- If experts contradict on a safety-critical point, flag the safer path
  explicitly`;

export async function synthesize(
  originalMessage: string,
  answers: DomainAnswer[],
  ctx: { athleteId?: string; messageId?: string },
): Promise<string> {
  if (answers.length === 0) {
    throw new Error("synthesize called with no domain answers");
  }
  const numbered = answers
    .map((a, i) => `${i + 1}. ${a.domain} expert:\n${a.text}`)
    .join("\n\n");
  const userPayload = `# Runner's message\n${originalMessage}\n\n# Expert answers\n${numbered}`;

  const res = await llmCall(
    {
      model: config.llm.synthesizerModel,
      system: SYSTEM,
      user: userPayload,
      maxTokens: 2000,
      temperature: 0.4,
      cacheSystem: true,
    },
    {
      athleteId: ctx.athleteId,
      messageId: ctx.messageId,
      component: "synthesizer",
    },
  );
  return res.text;
}
