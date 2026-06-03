import { and, eq, isNull } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { activeFlags } from "../db/schema.js";
import { llmCall } from "./llm-call.js";

// T11 — auto-flag detection.
//
// Runs after the binder and before routing in process-incoming. Scans
// the runner's inbound message for new persistent context flags (injury,
// illness, travel, life_event) and writes them to active_flags so the
// LLM sees them on the SAME turn — MARP can acknowledge "noted your
// Achilles" in the reply rather than waiting until the next message.
//
// Prompt lives at prompts/flag-detector.md and is strict by design:
// false positives pollute MARP's memory worse than false negatives. The
// LLM gets the current set of open flags so it doesn't duplicate them
// when the runner brings the same flag up across turns.
//
// Telemetry rolls up under llm_component="memory" — flag writes are
// part of MARP's memory layer, and pulling in a dedicated enum value
// for this would mean another migration without buying us much.

const FLAG_DETECTOR_PROMPT_PATH = "prompts/flag-detector.md";

// The pgEnum values. Keep in sync with src/db/schema.ts.
const VALID_KINDS = ["injury", "illness", "travel", "life_event"] as const;
type FlagKind = (typeof VALID_KINDS)[number];
function isFlagKind(s: string): s is FlagKind {
  return (VALID_KINDS as readonly string[]).includes(s);
}

export type DetectedFlag = {
  kind: FlagKind;
  body: string;
  startedAt: Date | null;
};

export type DetectResult = {
  created: Array<{ id: string; kind: FlagKind; body: string }>;
};

export async function detectFlags(
  athleteId: string,
  inboundMessageId: string,
  body: string,
): Promise<DetectResult> {
  if (!body.trim()) return { created: [] };

  const existingOpen = await db
    .select({ kind: activeFlags.kind, body: activeFlags.body })
    .from(activeFlags)
    .where(
      and(
        eq(activeFlags.athleteId, athleteId),
        isNull(activeFlags.resolvedAt),
      ),
    )
    .limit(20);

  const system = await getFlagDetectorPrompt();
  // Hand the existing flags to the LLM as compact JSON so it can
  // dedupe. Wrapping it as a # Existing flags block matches the shape
  // of every other user payload we send.
  const existingBlock =
    existingOpen.length > 0
      ? `# Existing open flags\n${JSON.stringify(existingOpen)}\n\n`
      : "# Existing open flags\n[]\n\n";
  const userPayload = `${existingBlock}# Runner's message\n${body}`;

  const res = await llmCall(
    {
      model: config.llm.binderModel, // Haiku — same tier as binder; cheap + fast
      system,
      user: userPayload,
      maxTokens: 200,
      temperature: 0,
      cacheSystem: true,
    },
    {
      athleteId,
      messageId: inboundMessageId,
      component: "memory",
    },
  );

  const parsed = parseFlagsJson(res.text);
  if (parsed.length === 0) return { created: [] };

  // Persist. Bulk insert in one round trip; returning() gives us back
  // the ids for telemetry.
  const inserts = parsed.map((f) => ({
    athleteId,
    kind: f.kind,
    body: f.body,
    ...(f.startedAt ? { startedAt: f.startedAt } : {}),
  }));
  const created = await db
    .insert(activeFlags)
    .values(inserts)
    .returning({
      id: activeFlags.id,
      kind: activeFlags.kind,
      body: activeFlags.body,
    });

  return {
    created: created.map((c) => ({
      id: c.id,
      kind: c.kind as FlagKind,
      body: c.body,
    })),
  };
}

// Defensive JSON parse — same pattern as classifier / binder. Drops
// rows with invalid kinds; doesn't throw, so a malformed payload still
// gracefully degrades to zero flags.
export function parseFlagsJson(raw: string): DetectedFlag[] {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== "object") return [];
  const rawFlags = (obj as Record<string, unknown>).flags;
  if (!Array.isArray(rawFlags)) return [];

  const out: DetectedFlag[] = [];
  for (const raw of rawFlags) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.kind !== "string" || !isFlagKind(o.kind)) continue;
    if (typeof o.body !== "string" || o.body.trim().length === 0) continue;
    const startedAt = parseStartedAt(o.started_at);
    out.push({
      kind: o.kind,
      body: o.body.trim(),
      startedAt,
    });
  }
  return out;
}

function parseStartedAt(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  // Accept ISO date or full ISO timestamp. Anything else → null so a
  // garbage value can't break the insert.
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

// Cached prompt body — read once at first call, same pattern as binder.
let cachedFlagDetectorPrompt: string | null = null;
async function getFlagDetectorPrompt(): Promise<string> {
  if (cachedFlagDetectorPrompt) return cachedFlagDetectorPrompt;
  const raw = await readFile(
    join(process.cwd(), FLAG_DETECTOR_PROMPT_PATH),
    "utf-8",
  );
  cachedFlagDetectorPrompt = raw
    .replace(/^---[\s\S]*?---\s*/, "")
    .trim();
  return cachedFlagDetectorPrompt;
}

// Test-only — reload the prompt from disk on next call.
export function _resetFlagDetectorPromptCache(): void {
  cachedFlagDetectorPrompt = null;
}
