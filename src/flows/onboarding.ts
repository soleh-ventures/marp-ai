import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { athletes, messages as messagesTable } from "../db/schema.js";
import { desc } from "drizzle-orm";
import { getOnboardingPrompt } from "../router/prompts.js";
import { llmCall } from "../services/llm-call.js";

// Onboarding state lives inside athletes.athletic_history under the
// `onboarding` key. The siblings of `onboarding` are the actual
// collected fields (name, age, target_race, etc.). This keeps the
// state co-located with the data so getMemoryContext picks up
// in-flight onboarding fields automatically.

export type OnboardingSection =
  | "basics"
  | "fitness"
  | "goal"
  | "lifestyle"
  | "injury"
  | "accountability"
  | "complete";

export type OnboardingMeta = {
  status: "pending" | "in_progress" | "complete";
  current_section: OnboardingSection;
  started_at: string;
  // Number of turns the LLM has taken so far — hard ceiling guards
  // against infinite loops if the LLM never returns "complete".
  turn_count: number;
};

export type AthleticHistory = Record<string, unknown> & {
  onboarding?: OnboardingMeta;
};

// Hard ceiling: even if the LLM never says "complete", we force-complete
// onboarding after this many turns so the runner isn't trapped in a
// loop forever.
const MAX_ONBOARDING_TURNS = 12;

// How many of the runner's most-recent messages to give the LLM as
// dialog history during onboarding. Smaller than the main brain's
// memory window — onboarding is about extraction, not deep recall.
const ONBOARDING_HISTORY_TURNS = 8;

export function getAthleticHistory(raw: unknown): AthleticHistory {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as AthleticHistory;
  }
  return {};
}

export function isOnboarded(history: AthleticHistory): boolean {
  return history.onboarding?.status === "complete";
}

function initialMeta(): OnboardingMeta {
  return {
    status: "in_progress",
    current_section: "basics",
    started_at: new Date().toISOString(),
    turn_count: 0,
  };
}

// Strip onboarding meta out — what we send the LLM as "data so far"
// should be just the collected fields, not our bookkeeping.
function dataFields(history: AthleticHistory): Record<string, unknown> {
  const { onboarding: _ob, ...rest } = history;
  return rest;
}

export type OnboardingTurnResult = {
  reply: string;
  newHistory: AthleticHistory;
  finishedThisTurn: boolean;
};

export async function runOnboardingTurn(
  athleteId: string,
  messageId: string,
  runnerMessage: string,
): Promise<OnboardingTurnResult> {
  // Load current state + recent dialog. We pull dialog directly here
  // instead of going through getMemoryContext to avoid pulling race
  // blocks, active flags, etc. — onboarding works with a thinner slice.
  const athleteRows = await db
    .select({
      id: athletes.id,
      name: athletes.name,
      athleticHistory: athletes.athleticHistory,
    })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  const athlete = athleteRows[0];
  if (!athlete) {
    throw new Error(`runOnboardingTurn: athlete ${athleteId} not found`);
  }

  const history = getAthleticHistory(athlete.athleticHistory);
  const meta: OnboardingMeta = history.onboarding ?? initialMeta();
  // The current inbound is already persisted by the webhook before we
  // run; pull the recent slice EXCLUDING this turn's own message so the
  // LLM doesn't see it duplicated in the history block.
  const recent = await db
    .select({ direction: messagesTable.direction, body: messagesTable.body })
    .from(messagesTable)
    .where(eq(messagesTable.athleteId, athleteId))
    .orderBy(desc(messagesTable.receivedAt))
    .limit(ONBOARDING_HISTORY_TURNS + 1);
  const chrono = [...recent].reverse().slice(0, -1); // drop the current inbound

  const userPayload = buildUserPayload({
    runnerMessage,
    meta,
    dataSoFar: dataFields(history),
    dialog: chrono,
  });

  const res = await llmCall(
    {
      model: config.llm.domainModel,
      system: getOnboardingPrompt(),
      user: userPayload,
      maxTokens: 600,
      temperature: 0.3,
      cacheSystem: true,
    },
    { athleteId, messageId, component: "other" },
  );
  const parsed = parseOnboardingResponse(res.text);

  // Merge extracted fields. Strings/numbers overwrite; arrays/objects
  // are deep-merged shallowly so multiple turns can add to e.g.
  // past_injuries without clobbering.
  const mergedData: Record<string, unknown> = { ...dataFields(history) };
  for (const [k, v] of Object.entries(parsed.extracted)) {
    const existing = mergedData[k];
    if (Array.isArray(existing) && Array.isArray(v)) {
      mergedData[k] = [...existing, ...v];
    } else if (
      existing && typeof existing === "object" &&
      v && typeof v === "object" && !Array.isArray(v)
    ) {
      mergedData[k] = { ...(existing as object), ...(v as object) };
    } else {
      mergedData[k] = v;
    }
  }

  const nextTurnCount = meta.turn_count + 1;
  const forceComplete = nextTurnCount >= MAX_ONBOARDING_TURNS;
  const nextSection: OnboardingSection = forceComplete
    ? "complete"
    : parsed.next_section;
  const finishedThisTurn = nextSection === "complete";

  const newMeta: OnboardingMeta = {
    status: finishedThisTurn ? "complete" : "in_progress",
    current_section: nextSection,
    started_at: meta.started_at,
    turn_count: nextTurnCount,
  };

  const newHistory: AthleticHistory = {
    ...mergedData,
    onboarding: newMeta,
  };

  // Persist. We also pick up `name` into athletes.name when the LLM
  // extracts it so it shows up cleanly in memory.athleteName without
  // having to dig into athletic_history.
  const newName =
    typeof parsed.extracted.name === "string"
      ? parsed.extracted.name
      : athlete.name;

  await db
    .update(athletes)
    .set({ athleticHistory: newHistory, name: newName })
    .where(eq(athletes.id, athleteId));

  return {
    reply: parsed.reply.trim(),
    newHistory,
    finishedThisTurn,
  };
}

type BuildUserInput = {
  runnerMessage: string;
  meta: OnboardingMeta;
  dataSoFar: Record<string, unknown>;
  dialog: Array<{ direction: "in" | "out"; body: string }>;
};

export function buildUserPayload(input: BuildUserInput): string {
  const parts: string[] = [];

  // The LLM's training-data date is frozen — without injecting today,
  // it'll guess at the year and get target_race.date wrong (Berlin
  // Marathon in 125 days might land in 2025 in the LLM's head when it's
  // actually 2026). Cheap, decisive fix.
  const today = new Date().toISOString().slice(0, 10);
  parts.push(`# Today's date\n${today}`);

  parts.push(`# Onboarding state`);
  parts.push(
    `current_section: ${input.meta.current_section}\nturn: ${input.meta.turn_count + 1} of max ${MAX_ONBOARDING_TURNS}`,
  );

  const knownKeys = Object.keys(input.dataSoFar);
  if (knownKeys.length === 0) {
    parts.push("# Data collected so far\n(none yet — this is the very first turn)");
  } else {
    parts.push(
      `# Data collected so far\n${JSON.stringify(input.dataSoFar, null, 2)}`,
    );
  }

  if (input.dialog.length > 0) {
    const dialogLines = input.dialog
      .map((m) => `${m.direction === "in" ? "RUNNER" : "MARP"}: ${m.body}`)
      .join("\n");
    parts.push(`# Recent conversation\n${dialogLines}`);
  }

  parts.push(`# Runner's latest message\n${input.runnerMessage}`);

  return parts.join("\n\n");
}

export type ParsedOnboardingResponse = {
  extracted: Record<string, unknown>;
  next_section: OnboardingSection;
  reply: string;
};

const VALID_SECTIONS: ReadonlySet<OnboardingSection> = new Set([
  "basics",
  "fitness",
  "goal",
  "lifestyle",
  "injury",
  "accountability",
  "complete",
]);

export function parseOnboardingResponse(raw: string): ParsedOnboardingResponse {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`onboarder returned non-JSON: ${raw.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new Error(
      `onboarder JSON parse failed: ${(err as Error).message} — raw: ${raw.slice(0, 200)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("onboarder response not an object");
  }
  const obj = parsed as Record<string, unknown>;
  const extracted =
    obj.extracted && typeof obj.extracted === "object" && !Array.isArray(obj.extracted)
      ? (obj.extracted as Record<string, unknown>)
      : {};
  const sectionRaw =
    typeof obj.next_section === "string" ? obj.next_section : "basics";
  const next_section: OnboardingSection = VALID_SECTIONS.has(
    sectionRaw as OnboardingSection,
  )
    ? (sectionRaw as OnboardingSection)
    : "basics";
  const reply = typeof obj.reply === "string" ? obj.reply : "";
  if (!reply.trim()) {
    throw new Error("onboarder produced empty reply");
  }
  return { extracted, next_section, reply };
}
