// S1 (KER-29) — lightweight operator alert for safety events.
//
// S1 ships a minimal alert: a structured, grep-able log line always, plus
// a best-effort WhatsApp ping to an operator number when one is
// configured. Durable event logging (a safety_events table) and richer
// alerting are S4 — kept out of S1 so the critical classifier ships now.

import { config } from "../../config.js";
import { sendWhatsApp } from "../twilio-send.js";
import type { SafetyTriage } from "./triage.js";

export async function alertOperator(
  athleteId: string,
  triage: SafetyTriage,
  message: string,
): Promise<void> {
  // Always log, structured + grep-able ("SAFETY_EVENT"), so it's visible
  // in Railway logs even with no operator number set.
  console.error(
    `SAFETY_EVENT tier=${triage.tier} category=${triage.category} ` +
      `athlete=${athleteId} reason=${JSON.stringify(triage.reason)} ` +
      `message=${JSON.stringify(message.slice(0, 200))}`,
  );

  const op = config.safety.operatorPhone;
  if (!op) return;
  try {
    await sendWhatsApp(
      op,
      `⚠️ MARP safety ${triage.tier.toUpperCase()} (${triage.category})\n` +
        `Athlete: ${athleteId}\n` +
        `Said: ${message.slice(0, 300)}`,
    );
  } catch (err) {
    // Never let an alert failure affect the runner's emergency response.
    console.error("safety alert: operator notify failed:", (err as Error).message);
  }
}
