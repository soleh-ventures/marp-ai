import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProd = nodeEnv === "production";

// Twilio auth token is required in prod (used to verify signed webhooks).
// In dev/test we allow a missing token but the webhook handler MUST refuse
// to accept requests unless SKIP_TWILIO_SIGNATURE=1 is explicitly set —
// otherwise an unauthenticated public endpoint ships by accident.
const twilioAuthToken = isProd
  ? required("TWILIO_AUTH_TOKEN")
  : (process.env.TWILIO_AUTH_TOKEN ?? "");

export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv,
  isProd,
  databaseUrl: required("DATABASE_URL"),
  twilio: {
    authToken: twilioAuthToken,
    // When set, overrides reconstructed URL (useful behind proxies/ngrok).
    publicWebhookBase: process.env.TWILIO_PUBLIC_WEBHOOK_BASE ?? "",
    // Dev escape hatch — never set in prod.
    skipSignature: process.env.SKIP_TWILIO_SIGNATURE === "1" && !isProd,
  },
};
