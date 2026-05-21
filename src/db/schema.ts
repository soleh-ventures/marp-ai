import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
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

export const athletes = pgTable("athletes", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").notNull().unique(),
  name: text("name"),
  locale: text("locale").notNull().default("en"),
  athleticHistory: jsonb("athletic_history"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
