// Calendar export intent — "add my plan to my calendar", the post-plan offer
// tap, and "reset my calendar link". Deterministic branch (no LLM): the June
// dogfood bug was the chat brain HALLUCINATING calendar-write offers it
// couldn't fulfill — the fix is a real, wired capability.

import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { athletes } from "../../db/schema.js";
import type { AthleticHistory } from "../../flows/onboarding.js";
import { getAthleticHistory } from "../../flows/onboarding.js";
import { generatePlanFeedToken } from "../cal/token.js";
import {
  buildGoogleMagicLinkUrl,
  isGoogleConfigured,
} from "../google-calendar.js";
import { findGoogleByAthleteId } from "../google-connections.js";
import type { ChoiceQuestion } from "../messaging/choices.js";

const EXPORT_PATTERNS = [
  /\b(add|put|export|get)\b.{0,30}\bplan\b.{0,20}\bcalendar\b/i,
  /\bcalendar\b.{0,25}\b(link|feed|export|subscribe)\b/i,
  /\b(subscribe|sync)\b.{0,20}\bcalendar\b/i,
  /^\s*calendar\s*$/i,
  /\bical\b|\bwebcal\b|\b\.ics\b/i,
];

const RESET_PATTERNS = [
  /\breset\b.{0,20}\bcalendar\b/i,
  /\bcalendar\b.{0,20}\breset\b/i,
  /\brevoke\b.{0,20}\bcalendar\b/i,
  /\bnew calendar link\b/i,
];

export function looksLikeCalendarExportRequest(body: string): boolean {
  const t = body.trim();
  if (t.length > 100) return false;
  return EXPORT_PATTERNS.some((re) => re.test(t));
}

export function looksLikeCalendarResetRequest(body: string): boolean {
  const t = body.trim();
  if (t.length > 100) return false;
  return RESET_PATTERNS.some((re) => re.test(t));
}

// Post-plan offer — appended to the plan reveal (Appendix A step 14: the
// calendar close is the flow's next step, not an epilogue). The signature is
// load-bearing: process-incoming attaches the offer buttons when the reply
// carries it (eng amendment 4 pattern).
export const CAL_OFFER_SIGNATURE = "Want this in your calendar?";
export const CAL_OFFER =
  "\n\n" +
  CAL_OFFER_SIGNATURE +
  " Every session, with the why baked in — and it updates itself when the " +
  "plan changes.";

export const Q_CAL_OFFER: ChoiceQuestion = {
  id: "caloffer",
  choices: [
    { value: "add_calendar", label: "📅 Add to my calendar", synonyms: ["add", "yes", "calendar"] },
    { value: "cal_later", label: "Later", synonyms: ["later", "not now", "no"] },
  ],
};

export const CAL_LATER_REPLY =
  "Anytime — just say \"calendar\" and I'll set it up.";

function feedUrls(athleteId: string, history: AthleticHistory): {
  https: string;
  webcal: string;
} | null {
  const base = config.twilio.publicWebhookBase.replace(/\/$/, "");
  if (!base) return null;
  const version =
    typeof history.cal_feed_version === "number" ? history.cal_feed_version : 1;
  const token = generatePlanFeedToken(athleteId, version);
  const https = `${base}/cal/plan/${encodeURIComponent(token)}.ics`;
  const webcal = https.replace(/^https?:\/\//, "webcal://");
  return { https, webcal };
}

// The export reply: Google sign-in first when available (real integration —
// MARP writes and re-syncs the events itself), webcal subscribe as the
// no-account path, download as the fallback. Returns null when the public
// base URL isn't configured (caller falls back to an honest "not set up"
// line).
export async function buildCalendarExportReply(
  athleteId: string,
  history: AthleticHistory,
): Promise<string | null> {
  const urls = feedUrls(athleteId, history);
  if (!urls) return null;

  // Google line: offered when configured and not already connected. The
  // athlete signs in once; MARP inserts every session and keeps them synced.
  let googleLine = "";
  if (isGoogleConfigured()) {
    const conn = await findGoogleByAthleteId(athleteId).catch(() => null);
    if (conn && !conn.revokedAt) {
      googleLine =
        "✅ Google Calendar is connected — sessions sync automatically.\n\n";
    } else {
      googleLine =
        "🔗 Best on Google Calendar: sign in once and I put every session " +
        "in myself, updates included (link expires in 5 min):\n" +
        buildGoogleMagicLinkUrl(athleteId) +
        "\n\n";
    }
  }

  return (
    "Here's your plan as a calendar — every session, with the why baked in:\n\n" +
    googleLine +
    `📲 Subscribe by link (works anywhere, auto-updates):\n${urls.webcal}\n\n` +
    `📥 Or a one-time import file:\n${urls.https}\n\n` +
    "iPhone: tap the subscribe link → Subscribe. Google Calendar without " +
    "sign-in: web → Settings → Add calendar → From URL → paste the .ics link."
  );
}

// ── Google Calendar connect / disconnect intents (PR 4) ────────────────

const GOOGLE_CONNECT_PATTERNS = [
  /\b(connect|link|sign\s*in|login|log\s*in|add)\b.{0,30}\bgoogle\b/i,
  /\bgoogle\s*(calendar|cal)\b.{0,20}\b(connect|link|sync|sign)/i,
  /^\s*connect\s+google(\s+calendar)?\s*$/i,
];

export function looksLikeGoogleConnect(body: string): boolean {
  const t = body.trim();
  if (t.length > 100) return false;
  return GOOGLE_CONNECT_PATTERNS.some((re) => re.test(t));
}

const CAL_DISCONNECT_PATTERNS = [
  /\b(disconnect|unlink|remove|revoke)\b.{0,25}\b(google|calendar)\b/i,
  /\b(google|calendar)\b.{0,25}\b(disconnect|unlink|remove|revoke)\b/i,
];

export function looksLikeCalendarDisconnect(body: string): boolean {
  const t = body.trim();
  if (t.length > 100) return false;
  return CAL_DISCONNECT_PATTERNS.some((re) => re.test(t));
}

export const Q_GCAL_DISCONNECT: ChoiceQuestion = {
  id: "gcaldis",
  choices: [
    { value: "gcal_del", label: "Delete them", synonyms: ["delete", "remove", "yes"] },
    { value: "gcal_keep", label: "Keep them", synonyms: ["keep", "leave", "no"] },
  ],
};

export const GCAL_DISCONNECT_CONFIRM =
  "I'll disconnect Google Calendar. Want me to also delete the MARP training " +
  "sessions I put in there, or leave them?";

export const GCAL_NOT_CONNECTED_REPLY =
  "Google Calendar isn't connected right now. Say \"connect google calendar\" " +
  "and I'll set it up.";

export function buildGoogleConnectReply(athleteId: string): string {
  if (!isGoogleConfigured()) {
    return (
      "Google Calendar sign-in isn't set up on this server yet. The subscribe " +
      "link still works — say \"calendar\" and I'll send it."
    );
  }
  return (
    "Sign in with Google and I'll put every training session straight into " +
    "your calendar — descriptions, updates and all. Link expires in 5 min:\n\n" +
    buildGoogleMagicLinkUrl(athleteId)
  );
}

export const CAL_NOT_CONFIGURED_REPLY =
  "Calendar links aren't set up on this server yet — the operator needs to " +
  "set the public URL. Your plan still lives right here in chat.";

// "Reset my calendar link" — bump the feed version; every previously shared
// URL goes 410 on its next fetch.
export async function resetCalendarFeed(athleteId: string): Promise<string> {
  const [row] = await db
    .select({ athleticHistory: athletes.athleticHistory })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  if (!row) return CAL_NOT_CONFIGURED_REPLY;
  const history = getAthleticHistory(row.athleticHistory);
  const current =
    typeof history.cal_feed_version === "number" ? history.cal_feed_version : 1;
  const next: AthleticHistory = { ...history, cal_feed_version: current + 1 };
  // A reset also un-marks calendar_connected so the funnel reflects the new link.
  delete next.calendar_connected_at;
  await db
    .update(athletes)
    .set({ athleticHistory: next })
    .where(eq(athletes.id, athleteId));
  const reply = await buildCalendarExportReply(athleteId, next);
  return (
    "Done — your old calendar links are dead.\n\n" +
    (reply ?? CAL_NOT_CONFIGURED_REPLY)
  );
}
