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

const SYSTEM = `You read a chat message where a runner says where they are or where they live, and extract their location plus whether this is a permanent MOVE or a temporary TRIP.

Return ONLY JSON: {"timezone": "<IANA name>", "city": "<City>", "kind": "move"|"trip"} or {"timezone": null}.

Rules:
- Use a canonical IANA name like "America/New_York", "Asia/Tokyo", "Europe/Berlin", "Australia/Sydney".
- "city" is the human city/place name as the runner would say it (e.g. "Berlin", "New York", "Bali"). Map it to the right IANA zone (NYC/New York -> America/New_York, London -> Europe/London, Bali -> Asia/Makassar).
- "kind": "move" when they are relocating / now live there ("I moved to X", "I now live in X", "relocated to X", "I'm based in X"). "trip" when they are only there temporarily ("I'm in X this week", "visiting X", "travelling to X", "here in X for a race").
- If the message names no real place (e.g. "I'm in pain", "I'm in the zone", "I'm in a rush"), return {"timezone": null}.
- Never invent a zone you are unsure of. When unsure, return {"timezone": null}.
- Output JSON only, no prose, no markdown.`;

export type ExtractTimezoneInput = {
  athleteId: string;
  messageId: string;
  body: string;
};

export type LocationChange = {
  timezone: string; // validated IANA zone
  city: string | null; // human city name, when the model gave one
  kind: "move" | "trip"; // permanent relocation vs temporary travel
};

// Returns a validated location change, or null when the message doesn't
// carry a usable location. Validates the IANA zone via Intl so a
// hallucinated zone never gets persisted. `kind` drives whether the HOME
// city (the location SSOT) is updated — see applyLocationChange.
export async function extractLocationFromMessage(
  input: ExtractTimezoneInput,
): Promise<LocationChange | null> {
  let raw: string;
  try {
    const res = await llmCall(
      {
        model: config.llm.classifierModel,
        system: SYSTEM,
        user: input.body,
        maxTokens: 80,
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
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const tz = parsed.timezone;
  if (typeof tz !== "string" || tz.trim() === "") return null;
  // Validate — Intl throws on a bogus zone.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return null;
  }
  const city =
    typeof parsed.city === "string" && parsed.city.trim() !== ""
      ? parsed.city.trim()
      : null;
  // Default to "trip" — the conservative choice. Only an explicit move
  // overwrites the home city, so a misread never silently repoints home.
  const kind = parsed.kind === "move" ? "move" : "trip";
  return { timezone: tz, city, kind };
}

// Persist a location change and return the confirmation reply.
//
// A MOVE updates the home-city SSOT (`homeCity` + `homeCitySetAt`) AND the
// timezone. A TRIP updates only the timezone so reminders land right while
// the runner is away, but `homeCity` is preserved — "where do I live"
// stays correct and reminders fall back to home once they return and
// correct the zone. (D2, KER-78.)
export async function applyLocationChange(
  athleteId: string,
  loc: LocationChange,
): Promise<string> {
  if (loc.kind === "move") {
    await db
      .update(athletes)
      .set({
        timezone: loc.timezone,
        ...(loc.city ? { homeCity: loc.city, homeCitySetAt: new Date() } : {}),
      })
      .where(eq(athletes.id, athleteId));
    const where = loc.city ? ` in ${loc.city}` : "";
    return (
      `Got it — I've updated your home${where} and I'll use ` +
      `${loc.timezone.replace(/_/g, " ")} for your reminders and training ` +
      `dates. Tell me again any time you move.`
    );
  }
  // Trip: timezone only, home preserved.
  await db
    .update(athletes)
    .set({ timezone: loc.timezone })
    .where(eq(athletes.id, athleteId));
  const where = loc.city ? ` while you're in ${loc.city}` : "";
  return (
    `Updated — I'll use ${loc.timezone.replace(/_/g, " ")} for your reminders ` +
    `and training dates${where}. I've kept your home on file; just say ` +
    `"I moved" if this is a permanent change.`
  );
}
