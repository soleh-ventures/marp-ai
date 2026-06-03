import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { db } from "../db/client.js";
import {
  activeFlags,
  activities,
  athletes,
  messages,
  raceBlocks,
} from "../db/schema.js";
import { llmCall } from "../services/llm-call.js";

// T8 — end-of-block narrative summarization.
//
// When a race_block transitions to "completed", we generate a free-text
// narrative summary capturing: how the build went, what broke, the race
// result, key learnings. That summary lives in race_blocks.summary and
// becomes MARP's long-term memory — it survives across blocks. When the
// runner starts a new race block 6 months later, MARP can recall:
//   "your IT band tightened in the last 3 weeks of build last time"
//   "you went out 30s/km too hot at Jakarta in March, faded the last 8K"
//
// Trigger:
//   - Manual: bun run admin:summarize-block <blockId> (CLI for ops)
//   - Auto: process-incoming.ts checks for active blocks whose race_date
//     has passed by > GRACE_PERIOD_DAYS and transitions + summarizes
//
// Persistence:
//   race_blocks.state → 'completed'
//   race_blocks.summary ← the narrative text
//
// Window for content selection:
//   Activities + flags + messages from (race_date - BUILD_WINDOW_DAYS)
//   through (race_date + RECOVERY_DAYS). This captures the build phase
//   plus the race itself and the immediate week of recovery chat that
//   often contains the runner's own debrief.

const SUMMARIZER_PROMPT_PATH = "prompts/block-summarizer.md";

// 18 weeks = a generous marathon block, including the long base. For
// shorter races (5K, 10K) the activity history will simply contain
// fewer prior weeks of training; the prompt handles that gracefully.
const BUILD_WINDOW_DAYS = 18 * 7;
const RECOVERY_DAYS = 7;

export type SummarizeBlockResult = {
  blockId: string;
  summaryLength: number;
  written: boolean;
};

export async function summarizeBlock(
  blockId: string,
): Promise<SummarizeBlockResult> {
  const rows = await db
    .select()
    .from(raceBlocks)
    .where(eq(raceBlocks.id, blockId))
    .limit(1);
  const block = rows[0];
  if (!block) throw new Error(`race_block ${blockId} not found`);
  // Idempotent: a re-run with a summary already in place is a no-op.
  if (block.summary) {
    return {
      blockId,
      summaryLength: block.summary.length,
      written: false,
    };
  }

  const windowStart = new Date(
    block.raceDate.getTime() - BUILD_WINDOW_DAYS * 86400_000,
  );
  const windowEnd = new Date(
    block.raceDate.getTime() + RECOVERY_DAYS * 86400_000,
  );

  // Pull all the block's content in parallel — none of the queries are
  // small but they're independent.
  const [athleteRows, activityRows, flagRows, messageRows] = await Promise.all(
    [
      db
        .select({ name: athletes.name, locale: athletes.locale })
        .from(athletes)
        .where(eq(athletes.id, block.athleteId))
        .limit(1),
      db
        .select({
          discipline: activities.discipline,
          startedAt: activities.startedAt,
          durationS: activities.durationS,
          metrics: activities.metrics,
          longRun: activities.longRun,
        })
        .from(activities)
        .where(
          and(
            eq(activities.athleteId, block.athleteId),
            gte(activities.startedAt, windowStart),
            lte(activities.startedAt, windowEnd),
          ),
        )
        .orderBy(asc(activities.startedAt)),
      db
        .select()
        .from(activeFlags)
        .where(
          // A flag is "active during the block window" iff:
          //   - it had started by the end of the window AND
          //   - it was still open (resolved_at IS NULL) OR
          //     it resolved on or after the window's start.
          and(
            eq(activeFlags.athleteId, block.athleteId),
            lte(activeFlags.startedAt, windowEnd),
            or(
              isNull(activeFlags.resolvedAt),
              gte(activeFlags.resolvedAt, windowStart),
            ),
          ),
        ),
      db
        .select({
          direction: messages.direction,
          body: messages.body,
          receivedAt: messages.receivedAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.athleteId, block.athleteId),
            gte(messages.receivedAt, windowStart),
            lte(messages.receivedAt, windowEnd),
          ),
        )
        .orderBy(asc(messages.receivedAt)),
    ],
  );

  const userPayload = buildSummarizerPayload({
    block,
    athleteName: athleteRows[0]?.name ?? null,
    activities: activityRows,
    flags: flagRows,
    messages: messageRows,
  });
  const system = await getSummarizerPrompt();

  const res = await llmCall(
    {
      model: config.llm.synthesizerModel, // Sonnet — narrative quality matters; this is rare
      system,
      user: userPayload,
      maxTokens: 600,
      temperature: 0.3,
      cacheSystem: true,
    },
    {
      athleteId: block.athleteId,
      // Block summaries don't tie to a single message; pass null and
      // let the telemetry row land on the block only.
      component: "memory",
    },
  );

  const summary = res.text.trim();
  if (!summary) {
    // Honest signal: LLM gave us nothing. Don't write empty.
    return { blockId, summaryLength: 0, written: false };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(raceBlocks)
      .set({
        summary,
        // Transition to completed if not already there. The auto-trigger
        // sets this anyway, but if a manual run hit an active row we
        // want both writes in one tx.
        state: "completed",
      })
      .where(eq(raceBlocks.id, blockId));
  });

  return { blockId, summaryLength: summary.length, written: true };
}

// Detect active race blocks past their race_date + grace period and
// transition them to completed, kicking off a background summarize.
// Called from process-incoming after every inbound. Designed to be
// cheap when there's nothing to do (single SELECT, common case is no
// stale block to transition).

const STALE_GRACE_DAYS = 7;

export async function autoTransitionStaleBlocks(
  athleteId: string,
): Promise<{ transitioned: string[] }> {
  const cutoff = new Date(Date.now() - STALE_GRACE_DAYS * 86400_000);
  const stale = await db
    .select({ id: raceBlocks.id })
    .from(raceBlocks)
    .where(
      and(
        eq(raceBlocks.athleteId, athleteId),
        eq(raceBlocks.state, "active"),
        lte(raceBlocks.raceDate, cutoff),
      ),
    );
  if (stale.length === 0) return { transitioned: [] };

  const transitioned: string[] = [];
  for (const row of stale) {
    // Fire summarizeBlock as fire-and-forget — caller doesn't await it.
    // summarizeBlock itself transitions state inside its transaction,
    // so we don't need to update state here. We just kick it off.
    summarizeBlock(row.id).catch((err) => {
      console.error(`summarizeBlock ${row.id} failed:`, err);
    });
    transitioned.push(row.id);
  }
  return { transitioned };
}

// ── Payload assembly ─────────────────────────────────────────────────────

type SummarizerPayloadInput = {
  block: typeof raceBlocks.$inferSelect;
  athleteName: string | null;
  activities: Array<{
    discipline: string;
    startedAt: Date;
    durationS: number;
    metrics: unknown;
    longRun: boolean;
  }>;
  flags: Array<{
    kind: string;
    body: string;
    startedAt: Date;
    resolvedAt: Date | null;
  }>;
  messages: Array<{
    direction: "in" | "out";
    body: string;
    receivedAt: Date;
  }>;
};

export function buildSummarizerPayload(input: SummarizerPayloadInput): string {
  const parts: string[] = [];

  parts.push(
    `# Race block\n` +
      `Athlete: ${input.athleteName ?? "Unknown"}\n` +
      `Race: ${input.block.raceName} (${input.block.raceDistance})\n` +
      `Date: ${input.block.raceDate.toISOString().slice(0, 10)}\n` +
      (input.block.goalFinishTime
        ? `Goal: ${input.block.goalFinishTime}`
        : "Goal: not set"),
  );

  if (input.activities.length > 0) {
    const lines = input.activities.map((a) => formatActivityForSummary(a));
    parts.push(
      `# Activities (${input.activities.length}, oldest first)\n${lines.join("\n")}`,
    );
  } else {
    parts.push("# Activities\n(none recorded in window)");
  }

  if (input.flags.length > 0) {
    const lines = input.flags.map((f) => {
      const start = f.startedAt.toISOString().slice(0, 10);
      const end = f.resolvedAt
        ? f.resolvedAt.toISOString().slice(0, 10)
        : "still open";
      return `  - ${f.kind}: ${f.body} (${start} → ${end})`;
    });
    parts.push(`# Flags during block\n${lines.join("\n")}`);
  }

  if (input.messages.length > 0) {
    const lines = input.messages.map((m) => {
      const date = m.receivedAt.toISOString().slice(0, 10);
      const role = m.direction === "in" ? "RUNNER" : "MARP";
      return `  [${date}] ${role}: ${m.body}`;
    });
    parts.push(`# Conversation (${input.messages.length} messages, oldest first)\n${lines.join("\n")}`);
  }

  return parts.join("\n\n");
}

function formatActivityForSummary(a: {
  discipline: string;
  startedAt: Date;
  durationS: number;
  metrics: unknown;
  longRun: boolean;
}): string {
  const date = a.startedAt.toISOString().slice(0, 10);
  const dur = formatDuration(a.durationS);
  const label = a.longRun ? `long ${a.discipline}` : a.discipline;
  const m = (a.metrics && typeof a.metrics === "object" && !Array.isArray(a.metrics)
    ? (a.metrics as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const distM = typeof m.distance_m === "number" ? m.distance_m : null;
  const paceS =
    typeof m.avg_pace_s_per_km === "number" ? m.avg_pace_s_per_km : null;
  const hr = typeof m.avg_hr === "number" ? Math.round(m.avg_hr) : null;
  const details: string[] = [];
  if (distM !== null && distM > 0) {
    let d = `${(distM / 1000).toFixed(1)}km`;
    if (paceS !== null && paceS > 0) d += ` @ ${formatPace(paceS)}`;
    details.push(d);
  }
  if (hr !== null) details.push(`HR ${hr}`);
  return details.length > 0
    ? `  ${date} ${label} ${dur} — ${details.join(", ")}`
    : `  ${date} ${label} ${dur}`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${m.toString().padStart(2, "0")}`;
}

function formatPace(secondsPerKm: number): string {
  const m = Math.floor(secondsPerKm / 60);
  const s = Math.round(secondsPerKm - m * 60);
  return `${m}:${s.toString().padStart(2, "0")}/km`;
}

// ── Prompt cache (same pattern as binder / flag-detector) ────────────────

let cachedSummarizerPrompt: string | null = null;
async function getSummarizerPrompt(): Promise<string> {
  if (cachedSummarizerPrompt) return cachedSummarizerPrompt;
  const raw = await readFile(
    join(process.cwd(), SUMMARIZER_PROMPT_PATH),
    "utf-8",
  );
  cachedSummarizerPrompt = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
  return cachedSummarizerPrompt;
}

export function _resetSummarizerPromptCache(): void {
  cachedSummarizerPrompt = null;
}
