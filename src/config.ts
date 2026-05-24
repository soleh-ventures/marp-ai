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

// LLM provider: "anthropic" (live) or "mock" (no API calls — for tests + offline dev).
// In tests we hard-set this to "mock" so the suite never spends tokens.
const llmProvider = (process.env.LLM_PROVIDER ?? "anthropic") as
  | "anthropic"
  | "mock";

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
  llm: {
    provider: llmProvider,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    // Default model per router component. Override via env if a domain
    // wants a stronger model.
    classifierModel: process.env.LLM_CLASSIFIER_MODEL ?? "claude-haiku-4-5",
    domainModel: process.env.LLM_DOMAIN_MODEL ?? "claude-sonnet-4-6",
    synthesizerModel: process.env.LLM_SYNTHESIZER_MODEL ?? "claude-sonnet-4-6",
  },
};
