import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { athletes } from "../db/schema.js";

// Twilio sends WhatsApp numbers as `whatsapp:+15551234567`. Strip the prefix
// so the stored phone is a portable E.164 string usable across channels.
export function normalizePhone(raw: string): string {
  return raw.replace(/^whatsapp:/i, "").trim();
}

export type Athlete = typeof athletes.$inferSelect;

export async function findOrCreateByPhone(rawPhone: string): Promise<Athlete> {
  const phone = normalizePhone(rawPhone);
  const existing = await db
    .select()
    .from(athletes)
    .where(eq(athletes.phone, phone))
    .limit(1);
  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(athletes)
    .values({ phone })
    .onConflictDoNothing({ target: athletes.phone })
    .returning();
  if (inserted[0]) return inserted[0];

  // Lost the insert race against a concurrent webhook for the same number —
  // re-read the row the winning insert created.
  const after = await db
    .select()
    .from(athletes)
    .where(eq(athletes.phone, phone))
    .limit(1);
  if (!after[0]) throw new Error(`athlete lookup failed for ${phone}`);
  return after[0];
}
