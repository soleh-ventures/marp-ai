import { Hono } from "hono";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { athletes } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { verifyMagicToken } from "../services/strava-magic-link.js";
import { buildAuthorizationUrl, exchangeCode } from "../services/strava-api.js";
import { upsertStravaConnection } from "../services/strava-connections.js";
import { backfillStravaHistory } from "../services/strava-backfill.js";
import { sendWhatsApp } from "../services/twilio-send.js";
import { getAthleticHistory, runOnboardingTurn } from "../flows/onboarding.js";

export const stravaAuth = new Hono();

// Build the absolute callback URL. Must match what's registered in
// Strava's app settings and what we pass to buildAuthorizationUrl.
function callbackUrl(): string {
  const base = config.twilio.publicWebhookBase.replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "TWILIO_PUBLIC_WEBHOOK_BASE must be set to handle Strava OAuth",
    );
  }
  return `${base}/auth/strava/callback`;
}

// ── GET /auth/strava/start?token=<magic-token> ────────────────────────────
//
// Entry point from the magic link we text to the runner. Validates the
// short-lived HMAC token, then redirects to Strava's OAuth consent page.
// We pass `athleteId` as `state` so the callback can find the record
// without a session cookie (stateless).
stravaAuth.get("/start", (c) => {
  const token = c.req.query("token");
  if (!token) {
    return c.text("Missing token", 400);
  }

  const result = verifyMagicToken(token);
  if (!result.ok) {
    const msgs = {
      malformed: "Invalid link — please request a new one from MARP.",
      bad_signature: "Invalid link — please request a new one from MARP.",
      expired: "This link has expired (5 min TTL). Text MARP to get a new one.",
    };
    return c.html(
      `<html><body><p>${msgs[result.reason]}</p></body></html>`,
      400,
    );
  }

  const { athleteId } = result.payload;
  const cb = callbackUrl();
  // ── Known v1 gap (CSRF / state-binding) ──────────────────────────────
  // We pass the raw athleteId as `state`, so the callback identifies who
  // to bind tokens to. An attacker who guesses an athleteId (UUID — not
  // enumerable) could complete the Strava auth flow with their OWN code
  // + state=<victim_uuid> and bind their Strava to the victim's MARP
  // account. Proper fix is PKCE, which requires server-side flow state
  // keyed by athleteId. Deferred — UUID guess + 5-min window is a narrow
  // attack surface for v1.
  const stravaUrl = buildAuthorizationUrl(cb, athleteId);
  return c.redirect(stravaUrl, 302);
});

// ── GET /auth/strava/callback?code=...&state=...&scope=... ────────────────
//
// Strava redirects here after the runner approves (or denies) the
// authorization. On success: exchange code for tokens, persist encrypted,
// send WhatsApp confirmation. On error: show a friendly message.
stravaAuth.get("/callback", async (c) => {
  const error = c.req.query("error");
  const code = c.req.query("code");
  const athleteId = c.req.query("state");

  if (error === "access_denied" || !code || !athleteId) {
    return c.html(
      `<html><body>
        <h2>Strava connection cancelled</h2>
        <p>No problem — text MARP if you'd like to try again.</p>
      </body></html>`,
      200,
    );
  }

  let cb: string;
  try {
    cb = callbackUrl();
  } catch (err) {
    console.error("strava callback: config error", err);
    return c.text("Server configuration error", 500);
  }

  try {
    const tokens = await exchangeCode(code, cb);
    await upsertStravaConnection(athleteId, tokens);

    // Confirm to the runner via WhatsApp. We backfill ~60 days of history
    // in the background (1–2 API calls) and send a single consolidated
    // message once that finishes, so the runner sees the count of past
    // activities loaded — no second WhatsApp ping, no waiting on the
    // OAuth success page.
    const rows = await db
      .select({
        phone: athletes.phone,
        athleticHistory: athletes.athleticHistory,
      })
      .from(athletes)
      .where(eq(athletes.id, athleteId))
      .limit(1);
    const phone = rows[0]?.phone;
    // F1 (v1.2): after connecting, hand the runner back into onboarding.
    // The OAuth callback is out-of-band (browser → server), so without
    // this the "connected" message is terminal and the runner sits in
    // silence not knowing to text again. Only kick off when onboarding
    // hasn't started yet — if they're mid-onboarding or done, a kickoff
    // would double-prompt.
    const onboardingStatus = getAthleticHistory(rows[0]?.athleticHistory)
      .onboarding?.status;
    const shouldKickoff =
      onboardingStatus === undefined || onboardingStatus === "pending";
    if (phone) {
      // Fire-and-forget: build the single consolidated confirmation message
      // and send it once. Backfill failure only degrades the "I pulled in N
      // runs" tail — it must not block the connect confirmation OR the
      // onboarding kickoff. We run onboarding turn 1 here (no inbound message
      // → null id) AFTER backfill so the onboarder sees the synced mileage
      // and skips asking for it.
      void (async () => {
        let tail = " New runs will sync as you log them.";
        try {
          const { inserted } = await backfillStravaHistory(athleteId);
          if (inserted > 0) {
            tail = ` I pulled in your last ${inserted} ${inserted === 1 ? "activity" : "activities"} (up to 60 days) — caught up on your recent training.`;
          }
        } catch (err) {
          console.error("strava callback: backfill failed", err);
        }
        // Fix: don't ask the runner to "reply first" — actually ASK the first
        // onboarding question now so they answer it directly.
        const kickoff = shouldKickoff ? await buildOnboardingKickoff(athleteId) : "";
        await sendWhatsApp(phone, "✅ Strava connected!" + tail + kickoff);
      })().catch((err) =>
        console.error("strava callback: confirm/kickoff send failed", err),
      );
    }

    return c.html(
      `<html><body>
        <h2>Strava connected!</h2>
        <p>Head back to WhatsApp — MARP will take it from here.</p>
      </body></html>`,
      200,
    );
  } catch (err) {
    console.error("strava callback: token exchange / upsert failed", err);
    return c.html(
      `<html><body>
        <h2>Something went wrong</h2>
        <p>Please text MARP to try connecting Strava again.</p>
      </body></html>`,
      500,
    );
  }
});

// Run onboarding turn 1 out-of-band so the post-Strava-connect message
// carries the ACTUAL first onboarding question (the compact details list)
// instead of "reply and I'll grab a few details." This persists the
// in-progress onboarding state, so the runner's reply lands as turn 2 and
// gets extracted normally. Returns the question prefixed with a blank line
// so it reads cleanly after the "Strava connected" confirmation.
//
// Best-effort: if the onboarding LLM call fails we fall back to the old
// static nudge rather than leaving the runner with no next step.
async function buildOnboardingKickoff(athleteId: string): Promise<string> {
  try {
    // No inbound message drove this turn → null message id. The synthetic
    // runner message just triggers the first turn; the onboarder ignores it
    // and emits its standard "set you up" list (minus mileage, since Strava
    // is now connected).
    const result = await runOnboardingTurn(
      athleteId,
      null,
      "Just connected my Strava.",
    );
    return "\n\n" + result.reply.trim();
  } catch (err) {
    console.error("strava callback: onboarding kickoff failed", err);
    return "\n\nNow let's get you set up — reply and I'll grab a few quick details to build your plan.";
  }
}
