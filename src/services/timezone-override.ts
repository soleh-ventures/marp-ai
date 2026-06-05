// F8d (v1.2) — chat-driven timezone override.
//
// The reminder timezone is normally derived from Strava / phone code,
// but expats and travellers need to correct it: "I live in NYC actually"
// or "I'm in Tokyo this week". This module detects that intent and pulls
// an IANA timezone out of the message.
//
// Two-stage to keep cost down:
//   1. A cheap regex pre-filter (looksLikeTimezoneChange) so we don't pay
//      for an LLM call on every inbound message.
//   2. A Haiku extraction that returns an IANA timezone or null. Null
//      means "the pre-filter matched but there's no real location here"
//      (e.g. "I'm in pain") — the caller falls through to normal routing.

import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { athletes } from "../db/schema.js";
import { llmCall } from "./llm-call.js";

// Strong location-change phrases — these alone are a reliable signal.
const STRONG_HINT =
  /\b(i live in|i'?m living in|moved to|relocat\w+ to|based in|currently in|i'?m now in|i'?m visiting|travel\w* to|flying to|fly to|over in|my timezone|(set|change)\s+(my\s+)?timezone)\b/i;

// "I'm in <place>" / "I am in <place>" — broad, so we guard against the
// very common running-chat false positives ("I'm in pain", "I'm in the
// zone", "I'm in a rush"). A null Haiku call on every "I'm in pain" is
// pure waste on a hot path, and the founder is cost-conscious (F4).
const IM_IN_PLACE =
  /\bi(?:'?m| am) in (?!pain\b|the\b|a\b|an\b|good\b|bad\b|great\b|ok\b|okay\b|shape\b|form\b|trouble\b|agony\b|charge\b|control\b|need\b|love\b)[a-z]/i;

export function looksLikeTimezoneChange(body: string): boolean {
  return STRONG_HINT.test(body) || IM_IN_PLACE.test(body);
}

const SYSTEM = `You extract an IANA timezone from a chat message where a runner says where they are or where they live.

Return ONLY JSON: {"timezone": "<IANA name>"} or {"timezone": null}.

Rules:
- Use a canonical IANA name like "America/New_York", "Asia/Tokyo", "Europe/Berlin", "Australia/Sydney".
- Map cities/regions/countries to the right zone (NYC/New York -> America/New_York, London -> Europe/London, Bali -> Asia/Makassar).
- If the message names no real place (e.g. "I'm in pain", "I'm in the zone", "I'm in a rush"), return {"timezone": null}.
- Never invent a zone you are unsure of. When unsure, return null.
- Output JSON only, no prose, no markdown.`;

export type ExtractTimezoneInput = {
  athleteId: string;
  messageId: string;
  body: string;
};

// Returns a validated IANA timezone string, or null when the message
// doesn't carry a usable location. Validates via Intl so a hallucinated
// zone never gets persisted.
export async function extractTimezoneFromMessage(
  input: ExtractTimezoneInput,
): Promise<string | null> {
  let raw: string;
  try {
    const res = await llmCall(
      {
        model: config.llm.classifierModel,
        system: SYSTEM,
        user: input.body,
        maxTokens: 60,
        temperature: 0,
        cacheSystem: true,
      },
      {
        athleteId: input.athleteId,
        messageId: input.messageId,
        component: "classifier",
      },
    );
    raw = res.text;
  } catch (err) {
    console.error("timezone-override: LLM call failed:", (err as Error).message);
    return null;
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const tz = (parsed as Record<string, unknown>)?.timezone;
  if (typeof tz !== "string" || tz.trim() === "") return null;
  // Validate — Intl throws on a bogus zone.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return null;
  }
  return tz;
}

// Persist the new timezone and return the confirmation reply.
export async function applyTimezoneOverride(
  athleteId: string,
  timezone: string,
): Promise<string> {
  await db
    .update(athletes)
    .set({ timezone })
    .where(eq(athletes.id, athleteId));
  return (
    `Updated — I'll use ${timezone.replace(/_/g, " ")} for your reminders ` +
    `and training dates now. Tell me again any time you move.`
  );
}
