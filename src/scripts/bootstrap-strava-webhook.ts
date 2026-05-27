#!/usr/bin/env bun
/**
 * One-shot subscription bootstrap for the Strava webhook.
 *
 * Usage:
 *   bun run strava:bootstrap
 *
 * Run after every deploy where TWILIO_PUBLIC_WEBHOOK_BASE changes (e.g.
 * spinning up a new Railway env, switching ngrok tunnels in dev). Safe
 * to re-run — it's a no-op when Strava is already pointing at the
 * correct callback URL.
 *
 * Required env vars:
 *   STRAVA_CLIENT_ID
 *   STRAVA_CLIENT_SECRET
 *   STRAVA_WEBHOOK_VERIFY_TOKEN
 *   TWILIO_PUBLIC_WEBHOOK_BASE   (this server must be reachable from the
 *                                  public internet — Strava will hit
 *                                  ${BASE}/webhooks/strava for the
 *                                  hub.challenge handshake before the
 *                                  POST to /push_subscriptions returns)
 */

import { config } from "../config.js";
import {
  realSubscriptionClient,
  reconcileStravaSubscription,
} from "../services/strava-subscriptions.js";

async function main(): Promise<void> {
  const missing: string[] = [];
  if (!config.strava.clientId) missing.push("STRAVA_CLIENT_ID");
  if (!config.strava.clientSecret) missing.push("STRAVA_CLIENT_SECRET");
  if (!config.strava.webhookVerifyToken) missing.push("STRAVA_WEBHOOK_VERIFY_TOKEN");
  if (!config.twilio.publicWebhookBase) missing.push("TWILIO_PUBLIC_WEBHOOK_BASE");
  if (missing.length > 0) {
    console.error(
      `Missing required env vars: ${missing.join(", ")}\n` +
        "Set them in .env (dev) or in your deploy environment (prod).",
    );
    process.exit(1);
  }

  console.log("Reconciling Strava webhook subscription…");
  const result = await reconcileStravaSubscription(realSubscriptionClient, {
    callbackBase: config.twilio.publicWebhookBase,
    verifyToken: config.strava.webhookVerifyToken,
  });

  console.log(`  action: ${result.action}`);
  console.log(`  callback_url: ${result.callbackUrl}`);
  console.log(`  subscription_id: ${result.subscriptionId}`);
  if (result.removedIds.length > 0) {
    console.log(`  removed_subscription_ids: ${result.removedIds.join(", ")}`);
  }
}

main().catch((err) => {
  console.error("bootstrap-strava-webhook failed:", err);
  process.exit(1);
});
