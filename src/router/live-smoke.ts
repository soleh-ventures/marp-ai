// One-shot live smoke test against the real Anthropic API. NOT part of
// the test suite (would burn tokens on every `bun test`) — run manually
// with: ANTHROPIC_API_KEY=... bun run src/router/live-smoke.ts
//
// Cost: ~2 LLM calls (classifier + 1 domain) on Haiku + Sonnet, well
// under $0.01.

import { sql } from "drizzle-orm";
import { db, sqlClient } from "../db/client.js";
import { athletes, llmCalls, messages } from "../db/schema.js";
import { route } from "./index.js";

async function main() {
  // Clean slate so the assertions below count only this run's calls.
  await db.execute(sql`
    TRUNCATE TABLE llm_calls, processed_messages, messages, active_flags,
      activities, race_blocks, athletes RESTART IDENTITY CASCADE
  `);

  const [athlete] = await db
    .insert(athletes)
    .values({ phone: "+15550000001", name: "Smoke Test" })
    .returning();
  if (!athlete) throw new Error("athlete insert failed");
  const [msg] = await db
    .insert(messages)
    .values({
      athleteId: athlete.id,
      direction: "in",
      body: "how should I structure my taper for a marathon in 3 weeks?",
    })
    .returning();
  if (!msg) throw new Error("message insert failed");

  console.log("→ routing a single-domain training question…");
  const result = await route({
    message: "how should I structure my taper for a marathon in 3 weeks?",
    athleteId: athlete.id,
    messageId: msg.id,
  });

  console.log("\n--- ROUTING ---");
  console.log(JSON.stringify(result.routing, null, 2));
  console.log("\n--- REPLY ---");
  console.log(result.finalText);
  console.log("\n--- LLM_CALLS LOGGED ---");

  const rows = await db.select().from(llmCalls);
  let totalCost = 0;
  for (const r of rows) {
    totalCost += r.costEstimateUsd;
    console.log(
      `  ${r.component.padEnd(12)} ${r.model.padEnd(22)} in=${r.tokensIn} out=${r.tokensOut} ${r.latencyMs}ms $${r.costEstimateUsd.toFixed(5)}`,
    );
  }
  console.log(`\nTotal cost: $${totalCost.toFixed(5)}`);
  console.log(`Total calls: ${rows.length}`);

  // Sanity assertions — the routing should be training-only for this
  // message, so we expect exactly 2 LLM calls and no synthesizer row.
  if (result.routing.domains.length === 0) {
    throw new Error("classifier returned no domains");
  }
  if (rows.length !== 1 + result.routing.domains.length) {
    throw new Error(
      `expected ${1 + result.routing.domains.length} llm_calls rows, got ${rows.length}`,
    );
  }
  if (!rows.some((r) => r.component === "classifier")) {
    throw new Error("no classifier row in llm_calls");
  }
  if (!rows.some((r) => r.component === "domain")) {
    throw new Error("no domain row in llm_calls");
  }

  console.log("\n✓ live smoke test passed");
  await sqlClient.end();
}

await main();
