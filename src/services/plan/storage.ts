// V6 (v1.1 flow redesign) — plan storage.
//
// V6.0 stashes plans on athletes.athletic_history.plan. A future
// migration moves this to race_blocks.plan once the race-block
// creation flow on onboarding-complete is wired in (V6.1+). This
// indirection keeps V6.0 from needing a schema change.
//
// Read path: getMemoryContext already surfaces athletic_history into
// the LLM's working memory, so a stored plan is automatically visible
// to coaching domain calls without further wiring.

import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { athletes } from "../../db/schema.js";
import {
  getAthleticHistory,
  type AthleticHistory,
} from "../../flows/onboarding.js";
import type { Plan } from "./types.js";

export async function saveAthletePlan(athleteId: string, plan: Plan): Promise<void> {
  const rows = await db
    .select({ athleticHistory: athletes.athleticHistory })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`saveAthletePlan: athlete ${athleteId} not found`);
  const history = getAthleticHistory(row.athleticHistory);
  const updated: AthleticHistory = { ...history, plan };
  await db
    .update(athletes)
    .set({ athleticHistory: updated })
    .where(eq(athletes.id, athleteId));
}

export function getStoredPlan(history: AthleticHistory): Plan | null {
  const plan = history.plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  const obj = plan as Record<string, unknown>;
  if (typeof obj.version !== "number") return null;
  if (!Array.isArray(obj.weeks)) return null;
  // Trust the persisted shape — parsePlan was applied on write. We
  // don't re-validate on every read; the cost would be wasted on
  // already-known-good data.
  return plan as unknown as Plan;
}
