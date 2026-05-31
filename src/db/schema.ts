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
  },
  (t) => [index("messages_athlete_received_idx").on(t.athleteId, t.receivedAt)],
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
