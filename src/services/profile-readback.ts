// KER-78 (Grounded Coach, Phase 1, 1d) — deterministic profile readback.
//
// When the runner asks a direct factual question about their own profile
// ("where do I live?", "what's my goal?", "what do you know about me?"),
// answer from stored data with NO LLM in the loop. The whole bug class is
// the LLM confabulating these facts; the safest fix for a direct question
// is to never ask the LLM at all. Missing fields are reported as "not on
// file" — we never guess.

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { athletes, raceBlocks } from "../db/schema.js";
import { getAthleticHistory } from "../flows/onboarding.js";

const LOCATION_Q =
  /\b(where do i live|where am i (based|living)|what(?:'?s| is) my (home|city|location)|which city do i live)\b/i;
const GOAL_Q =
  /\b(what(?:'?s| is) my (goal|target|target time|goal time|race goal)|what am i (training|aiming|going) for|what(?:'?s| is) my race)\b/i;
const PROFILE_Q =
  /\b(what do you know about me|what(?:'?s| is) (on file|in my profile|my profile)|my (profile|details|info)( on file)?|what have you got on me)\b/i;

export type ProfileQuestionKind = "location" | "goal" | "profile";

// Cheap pure pre-check. Returns the kind of profile question, or null.
export function profileQuestionKind(body: string): ProfileQuestionKind | null {
  if (PROFILE_Q.test(body)) return "profile";
  if (LOCATION_Q.test(body)) return "location";
  if (GOAL_Q.test(body)) return "goal";
  return null;
}

function goalText(
  block: { raceName: string; raceDistance: string; goalFinishTime: string | null } | undefined,
  athleticHistory: unknown,
): string {
  if (block) {
    return block.goalFinishTime
      ? `${block.goalFinishTime} at ${block.raceName} (${block.raceDistance})`
      : `to finish ${block.raceName} (${block.raceDistance}) — no target time on file`;
  }
  const tr = (athleticHistory as Record<string, unknown> | null)?.target_race;
  if (tr && typeof tr === "object") {
    const t = tr as Record<string, unknown>;
    const name = typeof t.name === "string" ? t.name : null;
    const dist = typeof t.distance === "string" ? t.distance : null;
    const goalTime = typeof t.goal_time === "string" ? t.goal_time : null;
    const what = [dist, name && `(${name})`].filter(Boolean).join(" ") || "your race";
    return goalTime
      ? `${goalTime} for ${what} (no race scheduled yet)`
      : `to finish ${what} — no target time on file`;
  }
  return "not on file yet";
}

// Build the factual reply, or null if the athlete can't be loaded (caller
// falls through to normal routing). Pure read — never writes.
export async function buildProfileReadback(
  athleteId: string,
  kind: ProfileQuestionKind,
): Promise<string | null> {
  const rows = await db
    .select({
      name: athletes.name,
      homeCity: athletes.homeCity,
      timezone: athletes.timezone,
      athleticHistory: athletes.athleticHistory,
    })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  const a = rows[0];
  if (!a) return null;

  const blockRows = await db
    .select({
      raceName: raceBlocks.raceName,
      raceDistance: raceBlocks.raceDistance,
      goalFinishTime: raceBlocks.goalFinishTime,
    })
    .from(raceBlocks)
    .where(and(eq(raceBlocks.athleteId, athleteId), eq(raceBlocks.state, "active")))
    .orderBy(desc(raceBlocks.createdAt))
    .limit(1);
  const block = blockRows[0];

  const cityStr = a.homeCity ?? "not on file yet";

  if (kind === "location") {
    return a.homeCity
      ? `You're based in ${a.homeCity}. Just say "I moved to <city>" if that changes.`
      : `I don't have your home city on file yet — tell me where you're based and I'll save it.`;
  }
  if (kind === "goal") {
    return `Your goal on file: ${goalText(block, a.athleticHistory)}.`;
  }
  // profile: the facts I actually hold, verbatim.
  getAthleticHistory(a.athleticHistory); // (no-op guard kept for shape parity)
  const lines = [
    `Here's what I've got on file:`,
    `• Name: ${a.name ?? "not on file"}`,
    `• Home: ${cityStr}${a.timezone ? ` (${a.timezone.replace(/_/g, " ")})` : ""}`,
    `• Goal: ${goalText(block, a.athleticHistory)}`,
  ];
  return lines.join("\n");
}
