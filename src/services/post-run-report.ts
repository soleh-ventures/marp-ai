// Proactive post-run report — the "fire a message after each run with my
// training + the holistic analysis" feature. Runs after analyzeActivity has
// written the coach's read, composes summary + read + recovery/load, and sends
// it over whichever channel is active (Telegram or WhatsApp). Gated by the same
// proactive.outboundEnabled switch as the check-in.

import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { activities, activityAnalyses, messages } from "../db/schema.js";
import { getRecoveryContext } from "./athlete-readiness.js";
import { deliver } from "./messaging/deliver.js";

function fmtPace(sPerKm: number): string {
  const m = Math.floor(sPerKm / 60);
  const s = Math.round(sPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export async function sendPostRunReport(input: {
  athleteId: string;
  activityId: string;
}): Promise<{ sent: boolean; reason?: string }> {
  if (!config.proactive.outboundEnabled) {
    return { sent: false, reason: "proactive_disabled" };
  }

  const [act] = await db
    .select({
      discipline: activities.discipline,
      metrics: activities.metrics,
      longRun: activities.longRun,
    })
    .from(activities)
    .where(eq(activities.id, input.activityId))
    .limit(1);
  if (!act || act.discipline !== "run") return { sent: false, reason: "not_a_run" };

  const [an] = await db
    .select({ coachRead: activityAnalyses.coachRead })
    .from(activityAnalyses)
    .where(eq(activityAnalyses.activityId, input.activityId))
    .limit(1);

  const m = (act.metrics ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof m.distance_m === "number") parts.push(`${(m.distance_m / 1000).toFixed(1)} km`);
  if (typeof m.avg_pace_s_per_km === "number") parts.push(`${fmtPace(m.avg_pace_s_per_km)}/km`);
  if (typeof m.avg_hr === "number") parts.push(`avg HR ${Math.round(m.avg_hr)}`);

  const recovery = await getRecoveryContext(input.athleteId).catch(() => null);

  const lines: string[] = [
    `🏃 ${act.longRun ? "Long run" : "Run"} logged: ${parts.join(" · ") || "(summary unavailable)"}`,
  ];
  if (an?.coachRead) lines.push("", an.coachRead);
  if (recovery) lines.push("", recovery);
  const body = lines.join("\n");

  const res = await deliver(input.athleteId, body).catch((err) => {
    console.error(`post-run report send failed: ${(err as Error).message}`);
    return null;
  });
  if (!res) return { sent: false, reason: "send_failed" };

  await db.insert(messages).values({
    athleteId: input.athleteId,
    direction: "out",
    body,
    channel: res.channel,
    twilioMessageSid: res.channel === "whatsapp" ? res.providerMessageId : null,
  });
  return { sent: true };
}
