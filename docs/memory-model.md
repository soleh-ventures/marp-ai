# Memory model

How MARP "remembers" — the data structures, the retrieval flow, and the design decisions behind each one.

---

## The thesis

A coach holds three things in their head: who you are, what you've been doing, and what's currently being worked on. MARP's memory layer makes those three things first-class data, not derived from chat scrollback.

The runner experience is conversational ("MARP just *knows* I had a calf issue last month"); the implementation is structured rows the LLM reads via `getMemoryContext(athleteId)`.

---

## What gets surfaced on every reply

`src/memory/retrieve.ts` builds a single context string the router feeds to every domain and synthesizer prompt. Sections render in order, each skipped when empty:

1. **Athlete profile** — name + locale + `athletic_history` jsonb (years running, prior races, weekly volume, etc.)
2. **Strava status** — one line: `connected` / `connected (no activities yet)` / `revoked` / `not connected`. Explicit so the LLM doesn't infer from "I see no activities" that Strava is broken.
3. **Active race block** — name, distance, goal, days-to-race math
4. **Past blocks** — up to 3 most-recent completed blocks with non-null `summary`. The compounding memory across cycles.
5. **Active flags** — unresolved injuries, illnesses, travel, life events
6. **Recent training** — last 14 activities (newest-first), formatted with distance, pace, HR when present
7. **Recent conversation** — last 20 messages oldest-first

Caps are tuned: small enough to keep the prompt under ~4k tokens; large enough for the LLM to "remember." Each cap has a constant at the top of the file — change there, not inline.

---

## Schema overview

Eight tables hold memory-relevant state. Cross-table references all use UUIDs; phone numbers live only in `athletes`.

```
athletes
├── id (uuid, PK)
├── phone (text, unique-active)        ← natural key from Twilio
├── name (text, nullable)
├── locale (text, default 'en')
├── athletic_history (jsonb)           ← onboarding-captured profile
├── last_seen_at (timestamptz)         ← dormancy detection
├── archived_at (timestamptz, null)    ← dormancy "NEW" choice OR consent decline
├── consent_granted_at (timestamptz)   ← GDPR Article 6 gate
└── created_at (timestamptz)

messages                                 ← every inbound + outbound
├── id (uuid, PK)
├── athlete_id (uuid, FK CASCADE)
├── direction (enum: in/out)
├── body (text)
├── media_url (text, nullable)
├── twilio_message_sid (text, unique)  ← idempotency
├── received_at (timestamptz)
└── resolves_pending_decision_id (uuid, FK SET NULL)  ← binder back-pointer

active_flags
├── id (uuid, PK)
├── athlete_id (uuid, FK CASCADE)
├── kind (enum: injury, illness, travel, life_event)
├── body (text)                        ← one-sentence description
├── started_at (timestamptz)
└── resolved_at (timestamptz, null)    ← still-open if NULL

race_blocks
├── id (uuid, PK)
├── athlete_id (uuid, FK CASCADE)
├── race_name (text)
├── race_date (timestamptz)
├── race_distance (text)
├── goal_finish_time (text, nullable)
├── state (enum: pending, active, completed)
├── plan (jsonb, nullable)             ← reserved for v1.1 planner
├── summary (text, nullable)           ← T8 narrative summary
└── created_at (timestamptz)

activities
├── id (uuid, PK)
├── athlete_id (uuid, FK CASCADE)
├── race_block_id (uuid, FK SET NULL)
├── discipline (text)                  ← run / ride / swim / strength / ...
├── source (enum: strava, fit, gpx)
├── source_id (text)                   ← unique with source
├── started_at (timestamptz)
├── duration_s (int)
├── metrics (jsonb)                    ← distance_m, avg_pace_s_per_km, avg_hr, ...
├── raw_payload (jsonb)
├── long_run (bool)                    ← ≥16 km + discipline=run
└── created_at (timestamptz)

strava_connections                       ← one row per athlete who linked Strava
├── id (uuid, PK)
├── athlete_id (uuid, FK CASCADE, unique)
├── strava_athlete_id (bigint)         ← lookup key for webhook events
├── encrypted_access_token (text)      ← AES-256-GCM at rest
├── encrypted_refresh_token (text)
├── token_expires_at (timestamptz)
├── scope (text)
├── connected_at (timestamptz)
├── last_refreshed_at (timestamptz, null)
└── revoked_at (timestamptz, null)

pending_decisions                        ← binder state
├── id (uuid, PK)
├── athlete_id (uuid, FK CASCADE)
├── message_id (uuid, FK SET NULL)     ← outbound that posed the question
├── frame (jsonb)                      ← {question, options[{key,label,action_hint?}]}
├── created_at (timestamptz)
├── resolved_at (timestamptz, null)
└── resolved_key (text, null)

llm_calls                                ← cost / latency telemetry
├── id (uuid, PK)
├── athlete_id (uuid, FK SET NULL)
├── message_id (uuid, FK SET NULL)
├── component (enum: classifier, domain, synthesizer, memory, binder, ...)
├── model (text)
├── tokens_in (int)
├── tokens_out (int)
├── cache_hit (bool)
├── cache_read_tokens (int)
├── cost_estimate_usd (double)
├── latency_ms (int)
└── created_at (timestamptz)
```

---

## Why phone is the natural key (not the primary key)

The `id` UUID is the foreign-key target everywhere. `phone` is unique-when-active (partial index `WHERE archived_at IS NULL`) so an archived account can free its phone for a new athlete after a dormancy "NEW" choice or a consent decline.

Three identifier scopes:

| Scope | Identifier | Where it comes from |
|---|---|---|
| Internal | `athletes.id` (UUID) | Generated by Drizzle |
| External (Twilio) | `phone` (E.164) | Twilio's `From` field |
| External (Strava) | `strava_athlete_id` (bigint) | Strava OAuth response |

Logs and errors use UUID. Phone is PII and only appears in:

- The `athletes.phone` column
- The Twilio outbound `To` field
- `redactPhone()` output when a UUID isn't available yet

See `docs/privacy.md` for the redaction rules.

---

## Why active flags are typed, not freeform

Four kinds: `injury`, `illness`, `travel`, `life_event`. The `body` field is a one-sentence summary; the type is constrained because:

1. **Memory rendering**: each kind has different surfacing logic (e.g., injuries influence training recommendations differently than travel)
2. **Auto-detection precision**: the flag-detector LLM picks from a closed vocabulary — harder to invent a "fatigue" or "motivation" type that pollutes the memory layer
3. **Future automation**: a planner that reads "active flags by kind" can apply different rules per kind

A `resolved_at` timestamp soft-resolves a flag rather than deleting it. Resolved flags stay in the row history (useful for the block summarizer, which includes resolved-within-window flags), but `getMemoryContext` filters to unresolved only.

---

## Why race blocks have a separate `summary` field

At v1, runners onboard with a target race; the `race_blocks` row gets `state=active`. When the race date passes by 7 days, `autoTransitionStaleBlocks` (called from `process-incoming.ts`) detects it, transitions to `state=completed`, and fires `summarizeBlock` as fire-and-forget.

`summarizeBlock` (in `src/memory/summarize.ts`):

1. Pulls activities in the window `[race_date - 18 weeks, race_date + 1 week]`
2. Pulls flags active during that window (`started_at ≤ window_end AND (resolved_at IS NULL OR resolved_at ≥ window_start)`)
3. Pulls all messages in the window
4. Calls Sonnet with `prompts/block-summarizer.md` — strict prompt (no motivational filler, no markdown, factual past tense)
5. Writes the result to `race_blocks.summary` inside a transaction that also flips `state` to `completed`

Idempotent: re-running on a block with a summary already in place is a no-op.

The summary then appears in `getMemoryContext` for every future memory query. Up to 3 past blocks render newest-first. This is MARP's compounding memory across training cycles.

For force-summarisation (e.g., to summarise mid-cycle for a runner who switched goals): `bun run admin:summarize-block <uuid>`.

---

## Why activity ingest is idempotent on `(source, source_id)`

A real unique index on `activities(source, source_id)` enables `ON CONFLICT DO NOTHING` for Strava and GPX ingest paths. Twilio media URL doubles as the GPX `source_id`; Strava activity ID doubles as the Strava `source_id`.

This matters because:

- **Strava sends webhook retries** if we don't ack within 2 seconds. Our handler is fast (`async` queue), but if Railway has a hiccup, Strava can deliver the same `create` event twice. ON CONFLICT makes the second one a silent no-op.
- **The Strava backfill** runs the same `INSERT` path. If a runner connects Strava, then 5 minutes later a webhook fires for an activity from the backfill window, the second insert is a no-op.
- **Manual GPX uploads** of the same file produce the same media URL (Twilio's S3-backed). Repeated uploads → no double-counting.

The partial-WHERE variant we initially tried (`WHERE source_id IS NOT NULL`) was incompatible with `ON CONFLICT` — Postgres can't match against a partial index without re-specifying the predicate. We dropped the partial; NULLs are naturally distinct in unique indexes so legacy rows with `source_id=NULL` still coexist.

---

## Why we track Strava status explicitly in memory

The LLM has no reliable way to infer "is Strava connected?" from the activities list alone. A freshly-connected athlete with zero synced runs looks identical to an unconnected athlete (both have empty `activities`). So the memory context renders a separate line:

```
Strava: connected
Strava: connected (no activities recorded yet — only new/edited runs sync going forward)
Strava: previously connected but access was revoked — the runner needs to reconnect
Strava: not connected
```

`stravaStatus` is also exposed in the `MemoryContext` return type for observability (tests assert on it; future analytics can aggregate it).

This was bug-driven: the original implementation surfaced no signal and the LLM kept telling freshly-connected runners "Strava isn't connected, here's how to set it up." Fixed in PR #3.

---

## Where memory does NOT live

A few things you might expect to be in memory aren't:

- **Plans (structured periodised schedules)**: the `race_blocks.plan` jsonb column exists but is unused in v1. A planner that fills it is T8 in `TODO.md`.
- **Strava raw athlete profile** (gender, weight, age, country): we don't store any of this. Only the activity stream + the connection metadata.
- **HR / cadence / power from GPX uploads**: the parser doesn't extract `<extensions>` content. Only distance + duration + discipline.
- **Per-run narrative interpretations**: T10 (run stories) is in `TODO.md`. Today MARP reads the structured data and comments conversationally.
- **Past LLM replies**: outbound messages live in `messages`, but the LLM context only surfaces the last 20 raw messages, not a summary of past advice given. The block summarizer fills part of this gap at the cycle boundary.

---

## Cost of the memory context

Per LLM call:

- Domain prompt system: ~1000 input tokens (cached after first call)
- Memory context user payload: 500–2000 input tokens (varies by activity count, past-block summary count)
- Recent conversation: ~400 tokens (20 messages × ~20 tokens each)
- Total typical input: ~2000–3000 tokens

Caching kicks the system prompt down to 10% rate after first hit. The memory context portion is per-call (changes every message) and pays full rate. Total cost per single-domain reply: ~$0.003 with Sonnet, ~$0.0005 with Haiku.

See `src/services/llm/pricing.ts` for the cost math.

---

## Related docs

- `docs/architecture.md` — end-to-end flow
- `docs/privacy.md` — what we erase + export
- `docs/reference/admin-scripts.md` — `admin:summarize-block`, `admin:export-athlete`
- `src/memory/retrieve.ts` — the single source of truth for what gets surfaced
- `src/memory/summarize.ts` — block summarization
