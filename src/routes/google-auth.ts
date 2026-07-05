// Google Calendar OAuth routes (onboarding revamp PR 4).
//
//   GET /auth/google/start?token=<magic>   — chat magic link → Google consent
//   GET /auth/google/callback?code&state   — exchange, store, initial sync
//
// Unlike the Strava v1 flow (raw athleteId as state — documented gap), the
// state here is a signed 5-min HMAC token, so a forged callback can't bind an
// attacker's Google account to a victim's athleteId.

import { Hono } from "hono";
import { verifyMagicToken } from "../services/strava-magic-link.js";
import {
  buildGoogleAuthUrl,
  completeGoogleConnect,
  exchangeGoogleCode,
  isGoogleConfigured,
} from "../services/google-calendar.js";
import { deliver } from "../services/messaging/deliver.js";

export const googleAuth = new Hono();

function page(title: string, body: string): string {
  return (
    `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>` +
    `<body style="font-family: -apple-system, sans-serif; max-width: 26rem; margin: 4rem auto; padding: 0 1rem;">` +
    `<h2>${title}</h2><p>${body}</p></body></html>`
  );
}

const BAD_LINK = {
  malformed: "Invalid link — ask MARP for a new one.",
  bad_signature: "Invalid link — ask MARP for a new one.",
  expired: "This link has expired (5 min). Message MARP to get a fresh one.",
} as const;

googleAuth.get("/start", (c) => {
  if (!isGoogleConfigured()) {
    return c.html(
      page("Not available", "Google Calendar isn't configured on this server yet."),
      503,
    );
  }
  const token = c.req.query("token");
  if (!token) return c.text("Missing token", 400);

  const result = verifyMagicToken(token);
  if (!result.ok) {
    return c.html(page("Link problem", BAD_LINK[result.reason]), 400);
  }
  return c.redirect(buildGoogleAuthUrl(result.payload.athleteId), 302);
});

googleAuth.get("/callback", async (c) => {
  const error = c.req.query("error");
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (error === "access_denied") {
    return c.html(
      page(
        "No problem",
        "Google Calendar stays disconnected. You can always reconnect from chat — just say “connect google calendar”.",
      ),
    );
  }
  if (!code || !state) return c.text("Missing code/state", 400);

  const verified = verifyMagicToken(state);
  if (!verified.ok) {
    return c.html(page("Link problem", BAD_LINK[verified.reason]), 400);
  }
  const athleteId = verified.payload.athleteId;

  try {
    const tokens = await exchangeGoogleCode(code);
    const sync = await completeGoogleConnect(athleteId, tokens);

    const synced = sync ? sync.inserted + sync.updated : 0;
    const chatLine = sync
      ? `✅ Google Calendar connected — ${synced} sessions are in your calendar, and they'll update themselves when the plan changes.`
      : "✅ Google Calendar connected. As soon as you have a plan, the sessions land in your calendar automatically.";
    void deliver(athleteId, chatLine).catch(() => {});

    return c.html(
      page(
        "Connected ✅",
        sync
          ? `${synced} training sessions are now in your Google Calendar. They update automatically when your plan changes. You can close this tab and head back to the chat.`
          : "Connected. Your sessions will appear in Google Calendar once your plan exists. Head back to the chat.",
      ),
    );
  } catch (err) {
    console.error("google oauth callback failed:", (err as Error).message);
    return c.html(
      page(
        "Something went wrong",
        "The Google connection didn't complete. Head back to the chat and ask MARP for a fresh link.",
      ),
      500,
    );
  }
});
