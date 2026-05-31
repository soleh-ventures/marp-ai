import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { athletes } from "../db/schema.js";
import { redactPhone } from "./phone-redact.js";

// Twilio sends WhatsApp numbers as `whatsapp:+15551234567`. Strip the prefix
// so the stored phone is a portable E.164 string usable across channels.
export function normalizePhone(raw: string): string {
  return raw.replace(/^whatsapp:/i, "").trim();
}

export type Athlete = typeof athletes.$inferSelect;

// Active = archived_at IS NULL. Lookups + INSERT race-fallback always
// filter on this, so an archived account (post-NEW choice in dormancy
// challenge) doesn't shadow the fresh row.
export async function findOrCreateByPhone(rawPhone: string): Promise<Athlete> {
  const phone = normalizePhone(rawPhone);
  const existing = await db
    .select()
    .from(athletes)
    .where(and(eq(athletes.phone, phone), isNull(athletes.archivedAt)))
    .limit(1);
  if (existing[0]) return existing[0];

  // No ON CONFLICT here — the unique constraint is now a partial index
  // (WHERE archived_at IS NULL), which Postgres can't match against a
  // bare ON CONFLICT target list. If a concurrent webhook wins the
  // insert race the unique violation propagates; we catch and re-read.
  try {
    const [inserted] = await db.insert(athletes).values({ phone }).returning();
    if (inserted) return inserted;
  } catch (err) {
    // Postgres unique-violation = SQLSTATE 23505. Anything else is real.
    const code = (err as { code?: string }).code;
    if (code !== "23505") throw err;
  }

  // Race fallback — someone else's insert won.
  const after = await db
    .select()
    .from(athletes)
    .where(and(eq(athletes.phone, phone), isNull(athletes.archivedAt)))
    .limit(1);
  if (!after[0]) {
    throw new Error(`athlete lookup failed for ${redactPhone(phone)}`);
  }
  return after[0];
}
