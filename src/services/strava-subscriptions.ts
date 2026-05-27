import { desc } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { stravaWebhookConfig } from "../db/schema.js";

// Strava's push-subscription API. Each app has AT MOST one subscription
// (Strava-enforced — POST returns 400 if you try to create a second).
// This module handles:
//   1. The thin HTTP layer (list / create / delete on Strava's API)
//   2. The local mirror in strava_webhook_config (so the app knows what
//      subscription is live without re-querying Strava on every boot)
//   3. A reconcile function that's safe to run repeatedly: no-op if the
//      current subscription already points at our callback URL, otherwise
//      delete the stale one and create a fresh one.
//
// Reference: https://developers.strava.com/docs/webhooks/

const PUSH_SUB_URL = "https://www.strava.com/api/v3/push_subscriptions";

export type StravaSubscription = {
  id: number;
  application_id: number;
  callback_url: string;
  created_at: string;
  updated_at: string;
};

// Dependency-injectable HTTP layer so reconcile() can be unit-tested
// without hitting Strava's API in CI.
export type StravaSubscriptionClient = {
  list: () => Promise<StravaSubscription[]>;
  create: (callbackUrl: string, verifyToken: string) => Promise<{ id: number }>;
  remove: (id: number) => Promise<void>;
};

// ── HTTP layer ───────────────────────────────────────────────────────────

async function httpList(): Promise<StravaSubscription[]> {
  const url =
    `${PUSH_SUB_URL}?` +
    new URLSearchParams({
      client_id: config.strava.clientId,
      client_secret: config.strava.clientSecret,
    }).toString();
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`Strava list subscriptions ${res.status}: ${body}`);
  }
  return (await res.json()) as StravaSubscription[];
}

async function httpCreate(
  callbackUrl: string,
  verifyToken: string,
): Promise<{ id: number }> {
  // Strava insists on form-encoded for this endpoint. It also synchronously
  // performs the hub.challenge handshake against callback_url before the
  // POST returns — so the server hosting the callback must be reachable
  // from the public internet at the time of this call.
  const body = new URLSearchParams({
    client_id: config.strava.clientId,
    client_secret: config.strava.clientSecret,
    callback_url: callbackUrl,
    verify_token: verifyToken,
  });
  const res = await fetch(PUSH_SUB_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Strava create subscription ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { id: number };
  if (typeof json.id !== "number") {
    throw new Error("Strava create subscription: response missing id");
  }
  return { id: json.id };
}

async function httpDelete(id: number): Promise<void> {
  const url =
    `${PUSH_SUB_URL}/${id}?` +
    new URLSearchParams({
      client_id: config.strava.clientId,
      client_secret: config.strava.clientSecret,
    }).toString();
  const res = await fetch(url, { method: "DELETE" });
  // 204 No Content on success. Anything in the 2xx range is fine.
  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`Strava delete subscription ${id} ${res.status}: ${body}`);
  }
}

export const realSubscriptionClient: StravaSubscriptionClient = {
  list: httpList,
  create: httpCreate,
  remove: httpDelete,
};

// ── DB persistence (singleton row in strava_webhook_config) ──────────────

export async function saveSubscriptionRecord(
  subscriptionId: number,
  callbackUrl: string,
): Promise<void> {
  // The business invariant is "at most one row". We delete-then-insert
  // inside a transaction so the table is never empty mid-flight and we
  // never violate the unique constraint on subscription_id.
  await db.transaction(async (tx) => {
    await tx.delete(stravaWebhookConfig);
    await tx.insert(stravaWebhookConfig).values({
      subscriptionId,
      callbackUrl,
    });
  });
}

export async function getActiveSubscriptionRecord(): Promise<{
  subscriptionId: number;
  callbackUrl: string;
} | null> {
  const rows = await db
    .select({
      subscriptionId: stravaWebhookConfig.subscriptionId,
      callbackUrl: stravaWebhookConfig.callbackUrl,
    })
    .from(stravaWebhookConfig)
    .orderBy(desc(stravaWebhookConfig.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function clearSubscriptionRecords(): Promise<void> {
  await db.delete(stravaWebhookConfig);
}

// ── Reconcile ────────────────────────────────────────────────────────────

export type ReconcileResult = {
  action: "noop" | "created" | "replaced";
  subscriptionId: number;
  callbackUrl: string;
  removedIds: number[];
};

export function buildCallbackUrl(base: string): string {
  return `${base.replace(/\/$/, "")}/webhooks/strava`;
}

/**
 * Make Strava's subscription state match our desired callback URL,
 * persist the result locally, and return what changed. Safe to call
 * repeatedly — it's a no-op when already in the right state.
 */
export async function reconcileStravaSubscription(
  client: StravaSubscriptionClient,
  opts: { callbackBase: string; verifyToken: string },
): Promise<ReconcileResult> {
  const expectedCallback = buildCallbackUrl(opts.callbackBase);
  const existing = await client.list();
  const correct = existing.find((s) => s.callback_url === expectedCallback);

  if (correct && existing.length === 1) {
    // Exact match, nothing else lingering. Mirror it locally and exit.
    await saveSubscriptionRecord(correct.id, expectedCallback);
    return {
      action: "noop",
      subscriptionId: correct.id,
      callbackUrl: expectedCallback,
      removedIds: [],
    };
  }

  // Either callback URL drifted (rare — only on env-var changes / domain
  // migrations) or Strava is in an odd state with multiple rows.
  // Tear everything down before re-creating to avoid Strava's
  // "subscription already exists" 400.
  const removedIds: number[] = [];
  for (const s of existing) {
    await client.remove(s.id);
    removedIds.push(s.id);
  }

  const created = await client.create(expectedCallback, opts.verifyToken);
  await saveSubscriptionRecord(created.id, expectedCallback);

  return {
    action: existing.length > 0 ? "replaced" : "created",
    subscriptionId: created.id,
    callbackUrl: expectedCallback,
    removedIds,
  };
}
