import { config } from "../config.js";
import { llmCall } from "../services/llm-call.js";
import { extractDecisionFrame } from "./decision-frame.js";
import { getSynthesizerPrompt } from "./prompts.js";
import type { DecisionFrame, DomainAnswer } from "./types.js";

export type SynthesizeResult = {
  text: string;
  frame: DecisionFrame | null;
};

// The synthesizer only runs when the classifier picked >1 domain. It's the
// single point where multiple expert voices become one MARP voice.
// System prompt lives in prompts/synthesizer.md.
//
// ET6: if any domain emitted a decision_frame, we surface them to the
// synth so it can carry the structure into its unified reply (or
// reconcile multiple competing frames into one). The synth emits its
// own <decision_frame> block when appropriate; we strip + parse it the
// same way we do for domain replies.
export async function synthesize(
  originalMessage: string,
  answers: DomainAnswer[],
  ctx: { athleteId?: string; messageId?: string; isFork?: boolean },
): Promise<SynthesizeResult> {
  if (answers.length === 0) {
    throw new Error("synthesize called with no domain answers");
  }
  const numbered = answers
    .map((a, i) => {
      let block = `${i + 1}. ${a.domain} expert:\n${a.text}`;
      if (a.frame) {
        // Pass the structured frame to the synth so it can carry forward
        // or reconcile. Render compact JSON to keep tokens low.
        block += `\n  (proposed decision_frame: ${JSON.stringify(a.frame)})`;
      }
      return block;
    })
    .join("\n\n");
  const forkBlock = ctx.isFork ? "\n\n# Fork requested\ntrue" : "";
  const userPayload = `# Runner's message\n${originalMessage}${forkBlock}\n\n# Expert answers\n${numbered}`;

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
  const extracted = extractDecisionFrame(res.text);
  return { text: extracted.text, frame: extracted.frame };
}
