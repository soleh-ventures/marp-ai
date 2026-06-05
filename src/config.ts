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
    // Account SID + sandbox sender. Required for outbound replies. The
    // SID itself isn't secret (it's effectively a username) but we read
    // it from env to keep deploy config in one place.
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM ?? "whatsapp:+14155238886",
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
    // v1.3 (D2): model for FIRST plan creation — the highest-leverage,
    // once-per-user call. Defaults to Sonnet so Phase 1 ships with no cost
    // change; flip to an Opus id via LLM_PLAN_MODEL once the Sonnet-vs-Opus
    // eval (T5) confirms the quality delta is real. Plan ADJUSTMENTS stay on
    // domainModel (Sonnet) — smaller, more frequent, lower-stakes.
    planModel: process.env.LLM_PLAN_MODEL ?? "claude-sonnet-4-6",
    // Binder runs on every free-form fork reply. Separate var so we can
    // tune classifier ↔ binder independently (eng review CQ1).
    binderModel: process.env.LLM_BINDER_MODEL ?? "claude-haiku-4-5",
  },
  strava: {
    clientId: process.env.STRAVA_CLIENT_ID ?? "",
    clientSecret: process.env.STRAVA_CLIENT_SECRET ?? "",
    // Used for hub.challenge verify on subscription creation AND HMAC
    // verify on each incoming webhook POST.
    webhookVerifyToken: process.env.STRAVA_WEBHOOK_VERIFY_TOKEN ?? "",
    // 32-byte hex key for AES-256-GCM token encryption-at-rest.
    // Required when Strava is in use; fall through to empty in dev so
    // unit tests that don't touch Strava don't have to set it.
    tokenEncryptionKey: process.env.STRAVA_TOKEN_ENCRYPTION_KEY ?? "",
  },
  magicLink: {
    // Dedicated secret — NOT reused from TWILIO_AUTH_TOKEN per eng A3.
    secret: process.env.MAGIC_LINK_SECRET ?? "",
    ttlSeconds: 300, // 5 minutes; eng-review A3.
  },
  reminders: {
    // V8 deploy reality: Railway runs one always-on web service (the
    // Twilio webhook listener), so reminders dispatch in-process via a
    // 15-min interval timer inside the running server rather than an
    // external cron. Default ON in prod; off elsewhere so dev/test
    // boots never fire real WhatsApp messages. Explicit override via
    // REMINDER_SCHEDULER=on|off.
    inProcess:
      process.env.REMINDER_SCHEDULER === "on" ||
      (isProd && process.env.REMINDER_SCHEDULER !== "off"),
    // Interval must equal the scheduler's WINDOW_MINUTES so each local
    // reminder time falls in exactly one window per day (no gaps, no
    // overlap).
    intervalMs: 15 * 60 * 1000,
  },
};
