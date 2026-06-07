// M1 (T3) — post-run check-in.
//
// Right after a run lands, MARP asks "how did that feel?" — the single most
// valuable signal in the adaptive loop (runners reliably answer, per the
// office-hours observation). It is DECOUPLED from the analysis (decision 4A):
// the check-in always fires on a new run; the richer analysis runs separately
// and is allowed to fail without costing us this question.
//
// The copy is templated (not LLM) and VARIED (UX decision 6) — a varying,
// run-specific opener, never the identical line every time. Once the runner
// replies, the feeling-extraction path (T4) turns the answer into structured
// RunFeeling.
//
// OUTBOUND IS GATED behind config.proactive.outboundEnabled: a check-in is a
// business-initiated WhatsApp message, which needs a verified prod sender +
// approved template (KER-39 / KER-75). Until launch, we build + test the loop
// but don't actually send on the sandbox number.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { activities, athletes, messages } from "../db/schema.js";
import { config } from "../config.js";
import { sendWhatsApp } from "./twilio-send.js";

export type CheckInTextInput = {
  name?: string | null;
  discipline: string;
  distanceKm?: number | null;
  longRun?: boolean;
  // Chooses the phrasing variant. Caller passes a stable per-activity seed so
  // the copy varies across runs but is deterministic for one run (and for
  // tests). Defaults to 0.
  variant?: number;
};

// Run-specific, varied openers. Each ends with an open "how did it feel?"
// question — never a scale or a form (extraction handles structure later).
const RUN_VARIANTS: Array<(d: string) => string> = [
  (d) => `Nice — ${d} done. How'd that feel out there?`,
  (d) => `${d} in the bag. How were the legs on that one?`,
  (d) => `Saw your ${d} land. How'd it feel?`,
  (d) => `${d} done. How'd the body feel through it?`,
];

const LONG_RUN_VARIANTS: Array<(d: string) => string> = [
  (d) => `Big one done — ${d}. How'd you pull up?`,
  (d) => `${d} long run in the bag. How're the legs feeling?`,
];

export function buildCheckInText(input: CheckInTextInput): string {
  const distLabel =
    typeof input.distanceKm === "number" && input.distanceKm > 0
      ? `${formatKm(input.distanceKm)}k`
      : input.discipline === "run"
        ? "that run"
        : "that session";
  const pool =
    input.longRun && input.discipline === "run" ? LONG_RUN_VARIANTS : RUN_VARIANTS;
  const idx = Math.abs(input.variant ?? 0) % pool.length;
  const core = (pool[idx] ?? pool[0]!)(distLabel);
  const named = input.name && input.name.trim() && input.name !== "you";
  return named ? `${input.name!.trim()} — ${core}` : core;
}

function formatKm(km: number): string {
  // 12.0 -> "12", 12.4 -> "12.4"
  return Number.isInteger(km) ? String(km) : km.toFixed(1);
}

// Deterministic small seed from the activity id so phrasing varies per run.
function variantSeed(activityId: string): number {
  let h = 0;
  for (let i = 0; i < activityId.length; i++) {
    h = (h * 31 + activityId.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export type CheckInResult = { sent: boolean; reason?: string };

// Sends the check-in for a freshly-ingested activity. Self-contained: loads
// the athlete + activity. Only runs (the coached discipline) get a check-in.
export async function sendPostRunCheckIn(input: {
  athleteId: string;
  activityId: string;
}): Promise<CheckInResult> {
  const [act] = await db
    .select({
      discipline: activities.discipline,
      metrics: activities.metrics,
      longRun: activities.longRun,
    })
    .from(activities)
    .where(eq(activities.id, input.activityId))
    .limit(1);
  if (!act) return { sent: false, reason: "activity_not_found" };
  if (act.discipline !== "run") return { sent: false, reason: "not_a_run" };

  const [ath] = await db
    .select({ phone: athletes.phone, name: athletes.name })
    .from(athletes)
    .where(eq(athletes.id, input.athleteId))
    .limit(1);
  if (!ath) return { sent: false, reason: "athlete_not_found" };

  const distanceM =
    act.metrics && typeof (act.metrics as Record<string, unknown>).distance_m === "number"
      ? ((act.metrics as Record<string, number>).distance_m as number)
      : null;
  const text = buildCheckInText({
    name: ath.name,
    discipline: act.discipline,
    distanceKm: distanceM != null ? distanceM / 1000 : null,
    longRun: act.longRun,
    variant: variantSeed(input.activityId),
  });

  // Gate: until the prod sender + template are live, don't actually send —
  // building + testing the loop must not fire undeliverable sandbox messages.
  if (!config.proactive.outboundEnabled) {
    return { sent: false, reason: "proactive_disabled" };
  }

  const { twilioMessageSid } = await sendWhatsApp(ath.phone, text);
  // Persist the outbound so it's in conversation history and the feeling
  // reply has something to attach to.
  await db.insert(messages).values({
    athleteId: input.athleteId,
    direction: "out",
    body: text,
    twilioMessageSid,
  });
  return { sent: true };
}
