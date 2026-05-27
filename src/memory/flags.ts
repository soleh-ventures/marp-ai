import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { activeFlags } from "../db/schema.js";

// Flag mutators. Kept simple: add when the runner reports an issue,
// resolve when they say it's better. T9 onboarding + T11 delights will
// eventually have the brain set/resolve flags automatically from
// dialog; for now these are direct callable helpers + a foundation for
// that automation.

export type FlagKind = "injury" | "life_event" | "illness" | "travel";

export async function addFlag(
  athleteId: string,
  kind: FlagKind,
  body: string,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(activeFlags)
    .values({ athleteId, kind, body })
    .returning({ id: activeFlags.id });
  if (!row) throw new Error("active_flags insert returned nothing");
  return row;
}

export async function resolveFlag(flagId: string): Promise<void> {
  await db
    .update(activeFlags)
    .set({ resolvedAt: new Date() })
    .where(eq(activeFlags.id, flagId));
}

// Resolve every active flag of a given kind for one athlete. Useful for
// "knee feels good again" style messages where the runner doesn't
// reference the specific flag id.
export async function resolveActiveFlagsByKind(
  athleteId: string,
  kind: FlagKind,
): Promise<number> {
  const updated = await db
    .update(activeFlags)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(activeFlags.athleteId, athleteId),
        eq(activeFlags.kind, kind),
        isNull(activeFlags.resolvedAt),
      ),
    )
    .returning({ id: activeFlags.id });
  return updated.length;
}
