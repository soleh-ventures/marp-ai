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
    // KER-78 (Grounded Coach, Phase 1): the runner's HOME city — the
    // authoritative location fact. Together with `timezone` (the IANA half)
    // this is the location SSOT. Written only on a permanent-move intent
    // ("I moved to / now live in X"); a temporary trip ("I'm in X this
    // week") shifts `timezone` for reminders but leaves this untouched, so
    // "where do I live" never drifts to a travel destination. Surfaced as a
    // ground-truth line in the coaching context so the LLM stops grabbing a
    // stale city from the message log (measured 44% poisoning without it —
    // see eval:grounding / KER-77).
    homeCity: text("home_city"),
    homeCitySetAt: timestamp("home_city_set_at", { withTimezone: true }),
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

// ─── activity_streams (KER-80 — Grounded Coach, Phase 3) ────────────────────
// Strava streams SUMMARY per activity — per-km splits, split pattern, HR
// drift. Kept off `activities.metrics` (which is summary averages the context
// reads) and out of `raw_payload`, because a 90-min run is ~5k samples × N
// channels: we summarize at ingest and store only the compact result. The
// raw time-series never reaches the LLM. Consumed by the post-run read and
// the weekly evaluation; future M2 trait synthesis reads zone distribution
// from here (reconciles the activity_analyses "deferred to M2" note).
export const activityStreams = pgTable(
  "activity_streams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    summary: jsonb("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("activity_streams_activity_idx").on(t.activityId)],
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

// ─── safety_events (S4 / KER-32) ──────────────────────────────────────────
//
// One row per Tier-0 (emergency) or Tier-1 (referral) triage hit. The
// liability audit trail and the improvement signal for the safety
// classifier. Written best-effort — a failure here NEVER affects the
// runner's reply. message_id is SET NULL on message delete so an
// erasure cascade can clear the link without losing the safety record.
export const safetyEvents = pgTable(
  "safety_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references((): AnyPgColumn => messages.id, {
      onDelete: "set null",
    }),
    // "emergency" | "referral" — stored as text (no enum) so the tier
    // vocabulary can evolve with the classifier without a migration.
    tier: text("tier").notNull(),
    category: text("category").notNull(),
    reason: text("reason"),
    // First ~280 chars of the inbound message, for audit context.
    messageExcerpt: text("message_excerpt"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("safety_events_athlete_idx").on(t.athleteId, t.createdAt)],
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
    // Answer-quality debugging: the variable parts of the call so a bad
    // reply can be traced back to what produced it. We store only the
    // dynamic payload (input_user carries the retrieved memory/context)
    // and the model's reply. The system prompt is large + cached and
    // already lives in git keyed by `component`, so we don't duplicate it
    // per row. Both nullable: pre-migration rows have none, and erasure
    // NULLs them on athlete deletion (these hold PII — see erasure.ts).
    // The wrapper truncates each to a sane cap to bound row size.
    inputUser: text("input_user"),
    outputText: text("output_text"),
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

// ─── activity_analyses (M1 — adaptive coaching brain, KER-60) ───────────────
//
// One row per analyzed activity. Holds BOTH halves of the post-run signal,
// each independently nullable because they arrive on different paths:
//
//   objective ← post-run analysis (T2), the coach's read of the data
//   feeling   ← RunFeeling extraction (T4), the runner's reply to the check-in
//   coachRead ← the one-line fusion, written once both are in
//
// The check-in is DECOUPLED from analysis (eng-review decision 4A): a feeling
// reply can land even if analysis failed, and vice-versa. So whichever path
// fires first creates the row (upsert keyed by activity_id) and the other
// fills its column later. activity_id is unique → exactly one canonical
// analysis per run.
//
// onDelete cascade on both FKs: an analysis is meaningless without its
// activity, and GDPR erasure of the athlete must take it too.

export const activityAnalyses = pgTable(
  "activity_analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    // Objective coach-read from the analysis: per-km pattern, split-based
    // drift, etc. (streams-based zone distribution is deferred to M2). NULL
    // until analysis runs.
    objective: jsonb("objective"),
    // Subjective RunFeeling: { effort: {rpe?, band}, energy, pain, adherence,
    // context, verbatim }. NULL until the runner answers (or volunteers a
    // feeling). Shape owned by the extraction service (T4).
    feeling: jsonb("feeling"),
    // One-line fusion of objective + subjective. NULL until both are present.
    coachRead: text("coach_read"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One canonical analysis per activity — both T2 and T4 upsert onto it.
    uniqueIndex("activity_analyses_activity_idx").on(t.activityId),
    // The weekly retro's hot read: "this athlete's analyses this week."
    index("activity_analyses_athlete_created_idx").on(
      t.athleteId,
      t.createdAt,
    ),
  ],
);

// ─── plan_adjustments (M1 — adaptive coaching brain, KER-60) ────────────────
//
// The proactive weekly retro's proposal/apply log. Doubles as the retro's
// IDEMPOTENCY record: the weekly sweep proposes at most once per athlete per
// training week (the twilio-webhook-idempotency lesson applied to a scheduled
// mutation — a doubled plan change is worse than a missed one).
//
// Lifecycle: proposed → applied | declined | expired | superseded.
// The plan itself still lives on athletes.athletic_history.plan (the
// race_blocks migration stays deferred); this table is only the change log.

export const planAdjustmentTriggerEnum = pgEnum("plan_adjustment_trigger", [
  "weekly_sweep",
  "event",
]);

export const planAdjustmentStatusEnum = pgEnum("plan_adjustment_status", [
  "proposed",
  "applied",
  "declined",
  "expired",
  "superseded",
]);

export const planAdjustments = pgTable(
  "plan_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    // What fired this proposal: the scheduled weekly sweep, or an event-driven
    // trigger from a strong post-run signal (injury / high RPE / HR drift).
    trigger: planAdjustmentTriggerEnum("trigger").notNull(),
    status: planAdjustmentStatusEnum("status").notNull().default("proposed"),
    // The Monday (YYYY-MM-DD, athlete-local) of the training week this
    // proposal targets — the idempotency dimension for the weekly sweep.
    weekStart: text("week_start").notNull(),
    // The proposed change: structured diff + rationale + the decision_frame
    // shown to the runner. Shape owned by the retro service (T5).
    proposal: jsonb("proposal").notNull(),
    // Links to the binder's pending_decision so the confirm→apply path (T6)
    // resolves the proposal when the runner replies. SET NULL on decision
    // delete — the adjustment record survives as audit.
    pendingDecisionId: uuid("pending_decision_id").references(
      () => pendingDecisions.id,
      { onDelete: "set null" },
    ),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // History / hot read: an athlete's recent adjustments.
    index("plan_adjustments_athlete_created_idx").on(t.athleteId, t.createdAt),
    // Idempotency: at most one weekly_sweep proposal per (athlete, week).
    // Event-driven proposals are exempt — real mid-week signals can fire more
    // than once — so the unique index is partial on trigger = 'weekly_sweep'.
    uniqueIndex("plan_adjustments_weekly_idem_idx")
      .on(t.athleteId, t.weekStart)
      .where(sql`${t.trigger} = 'weekly_sweep'`),
  ],
);

// ─── weekly_evaluations (KER-79 — Grounded Coach, Phase 2) ──────────────────
// The end-of-week coach evaluation ledger. One row per (athlete, week) — the
// idempotency dimension so the many Sunday ticks collapse to a single
// evaluation even on weeks with NO plan change (the always-evaluate vision,
// which plan_adjustments can't hold since it only records changes). Also the
// revert store: beforePlan snapshots the plan prior to a coach-applied change
// so "keep it as it was" can restore it. Future: the KER-43 flywheel reads
// this as the adherence/outcome signal.
export const weeklyEvaluations = pgTable(
  "weekly_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    // Athlete-local Monday (YYYY-MM-DD) of the evaluated week.
    weekStart: text("week_start").notNull(),
    weekIndex: integer("week_index"),
    // The runner-facing coach evaluation text that was generated.
    evaluation: text("evaluation").notNull(),
    // Whether the coach changed the plan this week, and whether a medical
    // red flag forced propose-not-apply.
    adjusted: boolean("adjusted").notNull().default(false),
    safetyHold: boolean("safety_hold").notNull().default(false),
    changeSummary: text("change_summary"),
    rationale: text("rationale"),
    // Revert snapshot: the plan as it was BEFORE a coach-applied change (null
    // when nothing was applied), and the applied result.
    beforePlan: jsonb("before_plan"),
    afterPlan: jsonb("after_plan"),
    // "evaluated" (no change) | "applied" (coach changed it) | "reverted"
    // (runner undid it) | "proposed" (safety_hold — awaiting confirm).
    status: text("status").notNull().default("evaluated"),
    // When the proactive message actually went out (null while outbound is
    // gated off, or for the reactive path).
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("weekly_evaluations_athlete_created_idx").on(t.athleteId, t.createdAt),
    // One evaluation per athlete-week.
    uniqueIndex("weekly_evaluations_week_idem_idx").on(t.athleteId, t.weekStart),
  ],
);

// ─── garmin_wellness (personal recovery ingester — garmin-recovery-ingester) ─
// Daily recovery signals pulled from the founder's Garmin FR245 by the Python
// sidecar (garmin-sidecar/). Personal, single-user. `date` is Garmin's reported
// calendar date (device timezone) stored verbatim as YYYY-MM-DD so a cron in a
// different tz (or travel) can't drift the day. Unique (athlete_id, date) backs
// the sidecar's ON CONFLICT upsert (keep-non-null merge). readiness_* is the
// derived HRV-proxy score, computed once at ingest and read by the TS coach.
export const garminWellness = pgTable(
  "garmin_wellness",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    restingHr: integer("resting_hr"),
    vo2max: doublePrecision("vo2max"),
    hrvOvernight: doublePrecision("hrv_overnight"), // always null on FR245
    bodyBatteryHigh: integer("body_battery_high"),
    bodyBatteryLow: integer("body_battery_low"),
    bodyBatteryCharged: integer("body_battery_charged"),
    bodyBatteryDrained: integer("body_battery_drained"),
    bodyBatteryMorning: integer("body_battery_morning"),
    stressAvg: integer("stress_avg"),
    stressMax: integer("stress_max"),
    sleepTotalS: integer("sleep_total_s"),
    sleepDeepS: integer("sleep_deep_s"),
    sleepLightS: integer("sleep_light_s"),
    sleepRemS: integer("sleep_rem_s"),
    sleepAwakeS: integer("sleep_awake_s"),
    respSleepAvg: doublePrecision("resp_sleep_avg"),
    respWakingAvg: doublePrecision("resp_waking_avg"),
    respLow: doublePrecision("resp_low"),
    respHigh: doublePrecision("resp_high"),
    // Derived HRV proxy (percentile-of-3: RHR, morning body battery, sleep
    // quality) vs a personal trailing baseline. Band = top/mid/bottom tertile.
    readinessScore: integer("readiness_score"),
    readinessBand: text("readiness_band"),
    readinessComponents: jsonb("readiness_components"),
    raw: jsonb("raw"),
    source: text("source").notNull().default("garmin"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("garmin_wellness_athlete_date_idx").on(t.athleteId, t.date),
  ],
);
