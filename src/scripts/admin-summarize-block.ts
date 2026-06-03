#!/usr/bin/env bun
/**
 * Admin: force-summarize a race_block (T8).
 *
 * Usage:
 *   bun run admin:summarize-block <block-uuid>
 *
 * Idempotent — re-running on a block that already has a summary is a
 * no-op (returns the existing summary length). Transitions state to
 * `completed` if currently active.
 *
 * For local / dev:
 *   bun run src/scripts/admin-summarize-block.ts <uuid>
 *
 * For prod (Railway):
 *   railway run -- bun run src/scripts/admin-summarize-block.ts <uuid>
 */

import { summarizeBlock } from "../memory/summarize.js";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

async function main(): Promise<void> {
  const uuid = process.argv[2];
  if (!uuid || !isUuid(uuid)) {
    console.error("Usage: bun run admin:summarize-block <block-uuid>");
    process.exit(1);
  }

  console.log(`Summarizing race_block ${uuid}…`);
  const result = await summarizeBlock(uuid);
  console.log(`  written: ${result.written}`);
  console.log(`  summary length: ${result.summaryLength}`);
  if (!result.written && result.summaryLength > 0) {
    console.log("  (no-op — block already had a summary)");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("admin-summarize-block failed:", err);
  process.exit(1);
});
