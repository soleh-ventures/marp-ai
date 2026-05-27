import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "./config.js";
import { ping } from "./db/client.js";
import { validateAllPrompts } from "./router/prompts.js";
import { twilioWebhook } from "./webhooks/twilio.js";
import { stravaWebhook } from "./webhooks/strava.js";
import { stravaAuth } from "./routes/strava-auth.js";

// Fail loud at boot if any prompt file is missing or unparseable. Better
// than discovering it when the first runner texts MARP.
validateAllPrompts();

export const app = new Hono();

app.get("/", (c) => c.text("marp-ai"));

app.route("/webhooks/twilio", twilioWebhook);
app.route("/webhooks/strava", stravaWebhook);
app.route("/auth/strava", stravaAuth);

app.get("/health", async (c) => {
  const dbOk = await ping();
  const status = dbOk ? 200 : 503;
  return c.json(
    {
      status: dbOk ? "ok" : "degraded",
      db: dbOk ? "up" : "down",
      env: config.nodeEnv,
      version: "0.1.0",
    },
    status,
  );
});

// Bun sets import.meta.main on the entrypoint; Node leaves it undefined.
// Either way, only boot the listener when this file is run directly.
const isEntry =
  import.meta.main === true ||
  (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]));

if (isEntry) {
  serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
    console.log(`marp-ai listening on http://localhost:${port}`);
  });
}
