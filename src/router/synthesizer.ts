import { config } from "../config.js";
import { llmCall } from "../services/llm-call.js";
import { getSynthesizerPrompt } from "./prompts.js";
import type { DomainAnswer } from "./types.js";

// The synthesizer only runs when the classifier picked >1 domain. It's the
// single point where multiple expert voices become one MARP voice.
// System prompt lives in prompts/synthesizer.md.
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
      system: getSynthesizerPrompt(),
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
