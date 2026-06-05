import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ─── enums ────────────────────────────────────────────────────────────────

export const raceBlockStateEnum = pgEnum("race_block_state", [
  "pending",
  "active",
  "completed",
]);

export const activitySourceEnum = pgEnum("activity_source", [
  "strava",
  "fit",
  "gpx",
]);

export const activeFlagKindEnum = pgEnum("active_flag_kind", [
  "injury",
  "life_event",
  "illness",
  "travel",
]);

export const messageDirectionEnum = pgEnum("message_direction", ["in", "out"]);

export const llmComponentEnum = pgEnum("llm_component", [
  "classifier",
  "domain",
  "synthesizer",
  "memory",
  "content",
  // ET2: binder runs on every free-form reply that might resolve a
  // pending decision. Lives in its own enum value so cost / latency
  // telemetry isn't lumped under "other".
  "binder",
  "other",
]);

// ─── athletes ─────────────────────────────────────────────────────────────

export const athletes = pgTable(
  "athletes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Not directly unique — the partial index below enforces uniqueness
    // only across non-archived rows so an archived account can free its
    // phone number for a fresh row (phone-churn / number-recycling).
    phone: text("phone").notNull(),
    name: text("name"),
    locale: text("locale").notNull().default("en"),
    athleticHistory: jsonb("athletic_history"),
    // Updated on every inbound message. Read by the dormancy detection
    // to decide whether to send a re-auth challenge before resuming.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set when the runner chooses "NEW" in response to a dormancy
    // challenge (or when the operator archives via admin tool). The
    // row is preserved (audit) but its phone is no longer matched on
    // inbound lookups, so the next message creates a fresh athlete.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // GDPR Article 6 lawful basis — populated when the runner explicitly
    // accepts the privacy notice during onboarding ("YES" reply). NULL
    // means the athlete is pre-consent; no coaching content is shown
    // until this is set. Used as the "have we asked yet?" gate by
    // src/services/consent.ts.
    consentGrantedAt: timestamp("consent_granted_at", { withTimezone: true }),
    // V8 (v1.1): IANA timezone string captured after plan generation
    // (e.g., "Europe/Berlin"). Defaults inferred from the phone country
    // code; runner can override via chat. NULL = no reminders possible
    // (reminder cron skips silently to avoid wrong-time messages).
    timezone: text("timezone"),
    // F8b (v1.2): ISO 3166-1 alpha-2 country, inferred from the phone
    // dial code at the same point timezone is set. Persisted purely as
    // an insight dimension (where are runners signing up from?). NULL =
    // unknown dial code or not yet derived.
    country: text("country"),
    // V8: reminder preferences. JSON shape:
    //   { enabled: boolean, time_local: "HH:MM" }
    // enabled=false → opt-out (no reminders). When enabled=true, the
    // cron sends one reminder per training day at time_local in the
    // athlete's timezone. Defaulting to NULL ("not asked yet") lets the
    // capture flow know to prompt; an explicit {enabled:false} object
    // means the runner declined.
    reminderPrefs: jsonb("reminder_prefs"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Partial unique index — enforces "at most one active athlete per
    // phone." Archived rows are exempt so the same phone can host a
    // new account after a NEW choice.
    uniqueIndex("athletes_phone_active_idx")
      .on(t.phone)
      .where(sql`${t.archivedAt} IS NULL`),
  ],
);

// ─── race_blocks ──────────────────────────────────────────────────────────

export const raceBlocks = pgTable(
  "race_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    raceName: text("race_name").notNull(),
    raceDate: timestamp("race_date", { withTimezone: true }).notNull(),
    raceDistance: text("race_distance").notNull(),
    goalFinishTime: text("goal_finish_time"),
    state: raceBlockStateEnum("state").notNull().default("pending"),
    plan: jsonb("plan"),
    summary: text("summary"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("race_blocks_athlete_idx").on(t.athleteId)],
);

// ─── activities ───────────────────────────────────────────────────────────

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    raceBlockId: uuid("race_block_id").references(() => raceBlocks.id, {
      onDelete: "set null",
    }),
    discipline: text("discipline").notNull(),
    source: activitySourceEnum("source").notNull(),
    // Provider-side id (e.g. Strava activity id as text). Used to dedupe
    // when a webhook redelivers the same create event. Unique per (source,
    // source_id) — Postgres treats NULLs as distinct in unique indexes by
    // default, so legacy / manual entries with NULL source_id still coexist.
    sourceId: text("source_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    durationS: integer("duration_s").notNull(),
    metrics: jsonb("metrics"),
    rawPayload: jsonb("raw_payload"),
    longRun: boolean("long_run").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("activities_athlete_started_idx").on(t.athleteId, t.startedAt),
    index("activities_race_block_idx").on(t.raceBlockId),
    // Required by the webhook ingest's ON CONFLICT (source, source_id).
    // Postgres treats NULLs as distinct in unique indexes, so manual /
    // legacy rows with NULL source_id coexist without a partial WHERE
    // (and a partial index here would break ON CONFLICT matching).
    uniqueIndex("activities_source_source_id_idx").on(t.source, t.sourceId),
  ],
);

// ─── active_flags ─────────────────────────────────────────────────────────

export const activeFlags = pgTable(
  "active_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    kind: activeFlagKindEnum("kind").notNull(),
    body: text("body").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("active_flags_athlete_idx").on(t.athleteId)],
);

// ─── messages ─────────────────────────────────────────────────────────────

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    direction: messageDirectionEnum("direction").notNull(),
    body: text("body").notNull(),
    mediaUrl: text("media_url"),
    twilioMessageSid: text("twilio_message_sid").unique(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // ET8: back-pointer for inbound messages that resolved a pending
    // decision (set by the binder service). NULL for every message that
    // didn't close a fork — including all outbound. SET NULL on decision
    // delete so an erasure-cascade doesn't break referential integrity.
    resolvesPendingDecisionId: uuid("resolves_pending_decision_id").references(
      (): AnyPgColumn => pendingDecisions.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [index("messages_athlete_received_idx").on(t.athleteId, t.receivedAt)],
);

// ─── pending_decisions (ET8: binder chain) ────────────────────────────────
//
// When a domain or synthesizer reply contains a fork ("you could do A
// or B"), it emits a structured decision_frame that we persist here.
// The binder then matches future runner replies against open frames so
// MARP remembers what it asked, not just what it said.
//
// Resolution lifecycle:
//   - row inserted with resolved_at NULL when the outbound message ships
//   - binder sets resolved_at + resolved_key when an inbound message
//     matches a frame option
//   - the matching inbound's messages.resolves_pending_decision_id back-
//     points here for the binder's regex lookup
//
// FK rules per CEO S2 spec:
//   - athlete_id: CASCADE — erasure removes pending decisions too
//   - message_id (the outbound that posed the question): SET NULL —
//     the decision survives if we ever moderate-delete an outbound, the
//     resolution still has value
//
// Partial index on (athlete_id) WHERE resolved_at IS NULL keeps the
// binder's hot query — "open decisions for this athlete" — cheap.

export const pendingDecisions = pgTable(
  "pending_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    // Structured frame emitted by domain/synthesizer when is_fork=true.
    // Shape locked by ET6 (decision-frame schema):
    //   {
    //     question: string,          // human-readable summary of the fork
    //     options: [
    //       { key: string,           // stable identifier ("rest", "easy_run")
    //         label: string,         // user-facing label
    //         action_hint?: string } // optional 1-line rationale
    //     ]
    //   }
    frame: jsonb("frame").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // Which option (by `key` in frame.options) the runner chose. Populated
    // together with resolved_at; NULL while pending.
    resolvedKey: text("resolved_key"),
  },
  (t) => [
    index("pending_decisions_unresolved_idx")
      .on(t.athleteId)
      .where(sql`${t.resolvedAt} IS NULL`),
  ],
);

// ─── processed_messages (idempotency) ─────────────────────────────────────

export const processedMessages = pgTable("processed_messages", {
  twilioMessageSid: text("twilio_message_sid").primaryKey(),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── llm_calls (cost telemetry) ───────────────────────────────────────────

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    athleteId: uuid("athlete_id").references(() => athletes.id, {
      onDelete: "set null",
    }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    component: llmComponentEnum("component").notNull(),
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    // T6: Anthropic prompt-cache telemetry. cache_hit is the convenience
    // flag for `SELECT count(*) WHERE cache_hit` style queries;
    // cache_read_tokens carries the per-call breakdown so cost analysis
    // can compute "would we have paid more without caching?" Both default
    // to 0/false so non-Anthropic providers (mock) leave them untouched.
    cacheHit: boolean("cache_hit").notNull().default(false),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    costEstimateUsd: doublePrecision("cost_estimate_usd").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("llm_calls_created_idx").on(t.createdAt),
    index("llm_calls_athlete_idx").on(t.athleteId),
    index("llm_calls_component_idx").on(t.component),
  ],
);

// ─── strava_connections (S3) ──────────────────────────────────────────────
//
// One row per athlete who has connected Strava. Stores OAuth tokens
// encrypted at rest via AES-256-GCM (see src/services/token-cipher.ts).
// Eng review chose app-side encryption over pgcrypto for v1: no DB
// extension dependency, easier tests, identical security properties.
//
// onDelete: cascade on athlete deletion — orphan Strava rows are
// useless and a compliance liability.

export const stravaConnections = pgTable(
  "strava_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    athleteId: uuid("athlete_id")
      .notNull()
      .unique()
      .references(() => athletes.id, { onDelete: "cascade" }),
    // Strava's internal athlete id. Webhook events arrive keyed by this,
    // so we need to look up our athlete via it.
    stravaAthleteId: bigint("strava_athlete_id", { mode: "number" }).notNull(),
    // Ciphertext (base64) — never plaintext. See token-cipher.ts.
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true })
      .notNull(),
    scope: text("scope").notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    // Set when Strava returns 401 on refresh — runner must reconnect.
    // Refresh job skips rows with revoked_at set.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("strava_connections_strava_athlete_idx").on(t.stravaAthleteId),
    index("strava_connections_refresh_due_idx").on(t.tokenExpiresAt),
  ],
);

// ─── strava_webhook_config (S3) ───────────────────────────────────────────
//
// Singleton row tracking the app-level Strava webhook subscription.
// Strava only supports ONE subscription per app — events for every
// authorized athlete come through it. We persist subscription_id +
// callback_url so the boot-time bootstrap can be idempotent.

export const stravaWebhookConfig = pgTable("strava_webhook_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  subscriptionId: integer("subscription_id").notNull().unique(),
  callbackUrl: text("callback_url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
