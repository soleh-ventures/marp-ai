// Google Calendar integration (onboarding revamp PR 4) — the athlete signs in
// with Google once, and MARP writes every plan session into their primary
// calendar with the coaching description, then keeps it in sync on every plan
// change.
//
// Sync model: each event carries private extended properties
//   marp = "1"                    → "this event is MARP's to manage"
//   marp_session_uid = <spec.uid> → the stable upsert key (same uid as the
//                                    ICS feed, from planEventSpecs)
// Resync = list all marp=1 events → upsert by uid → delete stale. MARP never
// touches events it didn't create.
//
// Token lifecycle mirrors strava-tokens: refresh on expiry; invalid_grant →
// mark revoked (athlete reconnects via a fresh magic link).

import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { athletes } from "../db/schema.js";
import { getAthleticHistory } from "../flows/onboarding.js";
import { planEventSpecs, type PlanEventSpec } from "./cal/export.js";
import {
  decryptGoogleTokens,
  findGoogleByAthleteId,
  markGoogleRevoked,
  markGoogleSynced,
  updateGoogleRefreshedTokens,
  upsertGoogleConnection,
  type GoogleConnection,
  type GoogleTokenSet,
} from "./google-connections.js";
import { generateMagicToken } from "./strava-magic-link.js";
import { getStoredPlan } from "./plan/storage.js";
import { logFunnel } from "./funnel.js";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const EVENTS_BASE =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export class GoogleRevokedError extends Error {
  constructor() {
    super("Google connection revoked — athlete must reconnect");
  }
}

export function isGoogleConfigured(): boolean {
  return Boolean(
    config.google.clientId &&
      config.google.clientSecret &&
      config.twilio.publicWebhookBase,
  );
}

function redirectUri(): string {
  const base = config.twilio.publicWebhookBase.replace(/\/$/, "");
  return `${base}/auth/google/callback`;
}

// Chat-facing magic link → /auth/google/start. Same 5-min HMAC token as the
// Strava links (provider-agnostic payload).
export function buildGoogleMagicLinkUrl(athleteId: string): string {
  const base = config.twilio.publicWebhookBase.replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "TWILIO_PUBLIC_WEBHOOK_BASE is not set — required to build magic-link URLs",
    );
  }
  const token = generateMagicToken(athleteId);
  return `${base}/auth/google/start?token=${encodeURIComponent(token)}`;
}

// The consent-screen URL. `state` is a FRESH HMAC magic token (athlete-bound,
// 5-min TTL) — unlike the Strava v1 flow's raw-athleteId state, the callback
// verifies the signature, closing the cross-account state-binding gap.
export function buildGoogleAuthUrl(athleteId: string): string {
  const state = generateMagicToken(athleteId);
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    // Force the consent screen so a refresh_token is ALWAYS returned —
    // Google omits it on silent re-auth otherwise.
    prompt: "consent",
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
};

export async function exchangeGoogleCode(code: string): Promise<GoogleTokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token || !data.refresh_token) {
    throw new Error(
      `Google token exchange failed: ${res.status} ${data.error ?? ""}`.trim(),
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    scope: data.scope ?? SCOPE,
  };
}

// Decrypt + refresh-if-stale. Refresh keeps the old refresh_token when Google
// doesn't rotate it (it usually doesn't). invalid_grant → revoked.
async function getValidAccessToken(conn: GoogleConnection): Promise<string> {
  const { accessToken, refreshToken } = decryptGoogleTokens(conn);
  const now = Date.now();
  if (conn.tokenExpiresAt.getTime() - now > 60_000) return accessToken;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      grant_type: "refresh_token",
    }).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    if (data.error === "invalid_grant") {
      await markGoogleRevoked(conn.id);
      throw new GoogleRevokedError();
    }
    throw new Error(
      `Google token refresh failed: ${res.status} ${data.error ?? ""}`.trim(),
    );
  }
  await updateGoogleRefreshedTokens(conn.id, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
  });
  return data.access_token;
}

// ── Event mapping ─────────────────────────────────────────────────────

// Local wall-time end = start + duration, correct across midnight. The
// components are LOCAL (Google applies timeZone), so plain UTC arithmetic on
// them is safe.
export function localEnd(
  date: string,
  timeLocal: string,
  durationMin: number,
): { date: string; time: string } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = timeLocal.split(":").map(Number) as [number, number];
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm + durationMin));
  const p = (n: number) => n.toString().padStart(2, "0");
  return {
    date: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`,
    time: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`,
  };
}

export function specToGoogleEvent(
  spec: PlanEventSpec,
  timeZone: string,
): Record<string, unknown> {
  const end = localEnd(spec.date, spec.timeLocal, spec.durationMin);
  return {
    summary: spec.title,
    description: spec.description,
    start: { dateTime: `${spec.date}T${spec.timeLocal}:00`, timeZone },
    end: { dateTime: `${end.date}T${end.time}:00`, timeZone },
    extendedProperties: {
      private: { marp: "1", marp_session_uid: spec.uid },
    },
  };
}

// ── Google API calls (small, sequential — founder-scale) ──────────────

async function gcalFetch(
  accessToken: string,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

type GcalListItem = {
  id?: string;
  extendedProperties?: { private?: Record<string, string> };
};

// All MARP-managed events, uid → eventId. Paginates.
async function listMarpEvents(accessToken: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      privateExtendedProperty: "marp=1",
      maxResults: "2500",
      showDeleted: "false",
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await gcalFetch(accessToken, `${EVENTS_BASE}?${params}`);
    if (!res.ok) {
      throw new Error(`Google events.list failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      items?: GcalListItem[];
      nextPageToken?: string;
    };
    for (const item of data.items ?? []) {
      const uid = item.extendedProperties?.private?.marp_session_uid;
      if (uid && item.id) map.set(uid, item.id);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return map;
}

export type GoogleSyncResult = {
  inserted: number;
  updated: number;
  deleted: number;
};

// The core sync: plan → athlete's Google Calendar, idempotent by uid.
// Throws GoogleRevokedError when the athlete must reconnect.
export async function syncPlanToGoogle(
  athleteId: string,
): Promise<GoogleSyncResult | null> {
  const conn = await findGoogleByAthleteId(athleteId);
  if (!conn || conn.revokedAt) return null;

  const [row] = await db
    .select({
      athleticHistory: athletes.athleticHistory,
      timezone: athletes.timezone,
      reminderPrefs: athletes.reminderPrefs,
    })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  if (!row) return null;
  const history = getAthleticHistory(row.athleticHistory);
  const plan = getStoredPlan(history);
  if (!plan) return null;

  const timeZone = row.timezone ?? "UTC";
  const specs = planEventSpecs(plan, {
    preferredTime: history.preferred_time,
    reminderPrefs: row.reminderPrefs as {
      time_local?: string;
      timing?: string;
    } | null,
  });

  const accessToken = await getValidAccessToken(conn);
  const existing = await listMarpEvents(accessToken);

  let inserted = 0;
  let updated = 0;
  let deleted = 0;

  for (const spec of specs) {
    const body = JSON.stringify(specToGoogleEvent(spec, timeZone));
    const eventId = existing.get(spec.uid);
    if (eventId) {
      const res = await gcalFetch(accessToken, `${EVENTS_BASE}/${eventId}`, {
        method: "PATCH",
        body,
      });
      if (res.ok) updated++;
      else if (res.status === 404 || res.status === 410) {
        // Athlete deleted the event by hand — recreate it.
        const ins = await gcalFetch(accessToken, EVENTS_BASE, {
          method: "POST",
          body,
        });
        if (ins.ok) inserted++;
        else console.error(`gcal: re-insert failed ${ins.status} uid=${spec.uid}`);
      } else {
        console.error(`gcal: patch failed ${res.status} uid=${spec.uid}`);
      }
      existing.delete(spec.uid);
    } else {
      const res = await gcalFetch(accessToken, EVENTS_BASE, {
        method: "POST",
        body,
      });
      if (res.ok) inserted++;
      else console.error(`gcal: insert failed ${res.status} uid=${spec.uid}`);
    }
  }

  // Whatever's left in `existing` is stale (session removed/moved by a plan
  // change) — delete it. MARP-tagged events only, by construction.
  for (const [uid, eventId] of existing) {
    const res = await gcalFetch(accessToken, `${EVENTS_BASE}/${eventId}`, {
      method: "DELETE",
    });
    if (res.ok || res.status === 404 || res.status === 410) deleted++;
    else console.error(`gcal: delete failed ${res.status} uid=${uid}`);
  }

  await markGoogleSynced(conn.id);
  console.log(
    `evt=gcal_sync athlete=${athleteId} inserted=${inserted} updated=${updated} deleted=${deleted}`,
  );
  return { inserted, updated, deleted };
}

// Fire-and-forget resync — hooked into plan saves. Never blocks or throws
// into the caller; a revoked connection logs and stays revoked (the athlete
// gets a reconnect line on their next calendar interaction).
export function scheduleGoogleResync(athleteId: string): void {
  void syncPlanToGoogle(athleteId).catch((err) => {
    if (err instanceof GoogleRevokedError) {
      console.error(`evt=gcal_revoked athlete=${athleteId} (resync skipped)`);
    } else {
      console.error(`evt=gcal_sync_error athlete=${athleteId}:`, (err as Error).message);
    }
  });
}

// Full connect: store tokens + initial sync. Returns session count synced.
export async function completeGoogleConnect(
  athleteId: string,
  tokens: GoogleTokenSet,
): Promise<GoogleSyncResult | null> {
  await upsertGoogleConnection(athleteId, tokens);
  logFunnel("calendar_connected", athleteId);
  try {
    return await syncPlanToGoogle(athleteId);
  } catch (err) {
    console.error("gcal: initial sync failed:", (err as Error).message);
    return null;
  }
}

// Disconnect: optionally clear MARP events first (needs the still-valid
// token), then revoke at Google and mark locally.
export async function disconnectGoogle(
  athleteId: string,
  opts: { deleteEvents: boolean },
): Promise<{ deleted: number }> {
  const conn = await findGoogleByAthleteId(athleteId);
  if (!conn || conn.revokedAt) return { deleted: 0 };

  let deleted = 0;
  try {
    const accessToken = await getValidAccessToken(conn);
    if (opts.deleteEvents) {
      const existing = await listMarpEvents(accessToken);
      for (const [, eventId] of existing) {
        const res = await gcalFetch(accessToken, `${EVENTS_BASE}/${eventId}`, {
          method: "DELETE",
        });
        if (res.ok) deleted++;
      }
    }
    // Best-effort revoke — the local revoked_at is the source of truth.
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(accessToken)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }).catch(() => {});
  } catch (err) {
    console.error("gcal: disconnect cleanup failed:", (err as Error).message);
  }
  await markGoogleRevoked(conn.id);
  return { deleted };
}
