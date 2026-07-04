import { and, eq, isNull } from "drizzle-orm";
import { config } from "../config.js";
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

// Telegram counterpart of findOrCreateByPhone. Resolution order:
//   1. Already linked → return that athlete.
//   2. TELEGRAM_DEFAULT_ATHLETE_ID set → attach this chat to that existing
//      athlete (personal single-user: your Telegram → your real athlete row).
//   3. Otherwise create a new athlete. The athletes table requires a phone, so
//      a Telegram-only athlete gets a synthetic `tg:<chatId>` placeholder (the
//      WhatsApp sender is never used for it — channel resolves to telegram).
export async function findOrCreateByTelegramChatId(
  chatId: string,
): Promise<Athlete> {
  const existing = await db
    .select()
    .from(athletes)
    .where(
      and(eq(athletes.telegramChatId, chatId), isNull(athletes.archivedAt)),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  const linkId = config.telegram.defaultAthleteId;
  if (linkId) {
    const [linked] = await db
      .update(athletes)
      .set({ telegramChatId: chatId })
      .where(and(eq(athletes.id, linkId), isNull(athletes.telegramChatId)))
      .returning();
    if (linked) return linked;
    // Already linked to a different chat (or id not found) → re-read by id.
    const [byId] = await db
      .select()
      .from(athletes)
      .where(eq(athletes.id, linkId))
      .limit(1);
    if (byId) return byId;
  }

  const [inserted] = await db
    .insert(athletes)
    .values({ phone: `tg:${chatId}`, telegramChatId: chatId })
    .returning();
  if (!inserted) throw new Error(`telegram athlete create failed for ${chatId}`);
  return inserted;
}
