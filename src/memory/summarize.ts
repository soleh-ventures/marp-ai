// End-of-block narrative summarization.
//
// When a race_block transitions to "completed", we generate a free-text
// narrative summary capturing: how the build went, what worked, what
// broke, the race result, key learnings. That summary becomes the
// long-term memory that survives across blocks — so when the runner
// starts a new race block 6 months later, MARP remembers "you struggled
// with hamstring tightness in the last 3 weeks of build last time."
//
// Full implementation deferred — needs:
//   1. Trigger: when does this run? On block.state → "completed"
//      transition, kicked off by the planner or a manual command.
//   2. Inputs: every activity in the block + every active_flag (resolved
//      or not) + every message during the block window.
//   3. Output: a few-paragraph LLM summary written into
//      race_blocks.summary, then surfaced by getMemoryContext() on the
//      next block.
//
// For now the function exists so callers can compile against the API.
// T8 (planner) and T11 (delights) are the natural drivers.

import { db } from "../db/client.js";
import { raceBlocks } from "../db/schema.js";
import { eq } from "drizzle-orm";

export type SummarizeBlockResult = {
  blockId: string;
  summaryLength: number;
  // True when we wrote a summary, false when block already had one.
  written: boolean;
};

export async function summarizeBlock(
  blockId: string,
): Promise<SummarizeBlockResult> {
  const rows = await db
    .select({ id: raceBlocks.id, summary: raceBlocks.summary })
    .from(raceBlocks)
    .where(eq(raceBlocks.id, blockId))
    .limit(1);
  const block = rows[0];
  if (!block) throw new Error(`race_block ${blockId} not found`);
  if (block.summary) {
    return { blockId, summaryLength: block.summary.length, written: false };
  }
  // TODO(T8/T11): call the LLM to summarize activities + flags + chat.
  // For now do nothing — leaving summary null is the honest signal that
  // the block isn't summarized yet.
  return { blockId, summaryLength: 0, written: false };
}
