import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { processedMessages } from "../db/schema.js";

// Returns true if THIS call was the first to mark the sid (i.e. caller should
// process the message). Returns false if the sid was already recorded by an
// earlier delivery (caller should ack and drop).
//
// Implemented with INSERT ... ON CONFLICT DO NOTHING + RETURNING so the check
// and the write are a single atomic round-trip — no read-then-write race
// window between two simultaneous webhook deliveries.
export async function claimMessage(twilioMessageSid: string): Promise<boolean> {
  const rows = await db
    .insert(processedMessages)
    .values({ twilioMessageSid })
    .onConflictDoNothing({ target: processedMessages.twilioMessageSid })
    .returning({ sid: processedMessages.twilioMessageSid });
  return rows.length > 0;
}

// Test/dev only: clear a sid so a test can replay it.
export async function clearProcessed(twilioMessageSid: string): Promise<void> {
  await db.execute(
    sql`DELETE FROM processed_messages WHERE twilio_message_sid = ${twilioMessageSid}`,
  );
}
