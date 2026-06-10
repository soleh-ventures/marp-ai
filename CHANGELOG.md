# Changelog

All notable changes to marp-ai are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver in `package.json`.

## [0.6.3] — 2026-06-10 — Native WhatsApp typing indicator

### Changed
- Replaced the literal "thinking…" text message — sent as its own bubble on
  every LLM-bound turn — with the **native WhatsApp "typing…" indicator**
  (Twilio Public Beta, Oct 2025). No more clutter bubble; the runner sees the
  real typing affordance instead. Twilio references the inbound message SID,
  marks it read, and shows the indicator until our reply lands or 25s elapses.
  Best-effort and fire-and-forget: if the beta API fails the reply still sends,
  just without the bubble. The webhook now threads the inbound Twilio SID into
  `processIncomingMessage` so the LLM-bound branches can fire it. `thinking-ack`
  module renamed to `typing-indicator`. Note: the indicator marks the runner's
  message read (blue ticks) — inherent to the API.

### Fixed
- The post-onboarding plan pivot ("do you already have a plan (a), or should I
  build one (b)?") had two compounding bugs found in dogfooding. (1) A bare
  ordinal heuristic read the word "first" as option (a), so a reply like
  "(B) but my first day should be June 3rd" was mis-classified as BYO and got
  the "paste your plan" line — the explicit (B) never won. (2) Once in the
  BYO/`awaiting_plan` state, every message was treated as a pasted plan with
  no handler for "build it", so a runner who changed their mind looped on the
  same "that's not a plan" clarification forever. Both are fixed: the pivot now
  reads intent with an LLM (`pivot-intent.ts`) so it adapts to any phrasing, a
  bare "a"/"b" tap still short-circuits with no model call, and `awaiting_plan`
  now escapes to the build path on "build it" and routes real questions to the
  expert. The byo acknowledgement is LLM-generated (coach voice) instead of a
  fixed string; the old canned lines remain only as failure-path fallbacks.

### Added
- `prompts/pivot-intent.md` + `src/services/pivot-intent.ts` — adaptive intent
  read (byo / build / plan_content / question) for the plan pivot, with a
  prompt-injection guard and a deterministic fallback when the LLM read fails.

## [0.6.1] — 2026-06-08 — Grounded Coach: week-anchor fix (dogfood)

### Fixed
- The weekly evaluation anchored to the week containing *today*, so a "how did
  my week go?" asked on a Monday (or any early-week day) evaluated the empty
  just-started week instead of the one that just finished — mixing this week's
  (empty) adherence with last week's run signals into an incoherent read. Now
  anchors to the week of the runner's most recent activity. The proactive
  Sunday sweep is unaffected (Sunday's week is the finishing week either way).
  Found by running the new `dogfood-sim` harness against the live LLM.

### Added (dev)
- `src/scripts/dogfood-sim.ts` — seeds a realistic training week and runs the
  real coaching code (context build, profile readback, weekly evaluation)
  against the live LLM, so the coach's actual output can be eyeballed before a
  real dogfood week. Local-DB-guarded.

## [0.6.0] — 2026-06-08 — Grounded Coach (Phase 3: Strava depth)

Gives the coaching brain real data depth. Average pace/HR can't tell a negative
split from a positive one or catch cardiac drift; this pulls Strava's
per-sample streams and reads them like a coach.

### Added
- **Streams summarizer** (`strava-streams.ts`): per-km splits, split pattern
  (negative/even/positive), and HR drift, computed from the time/distance/
  heartrate channels. `activity_streams` table (migration 0015) stores the
  compact summary — the raw ~5k-sample arrays never reach the LLM.
- Captured **best-effort at ingest** for every distance-bearing activity —
  runs, rides, swims, walks, hikes (not just runs; bug #5). Fire-and-forget,
  so it never delays the runner's post-run reply.
- **Consumed everywhere:** the per-run coach read, the weekly evaluation, and
  the coaching context now cite the real shape ("negative split, HR drift
  +7%, km 4:30–5:00"), not just the average.
- **Activity descriptions:** the runner's own Strava notes are captured and
  surfaced as a coaching signal (sanitized — runner-controlled free text is
  stripped of control chars/quotes before it enters the prompt).
- **History backfill** (`streams:backfill`): walks existing activities with no
  streams summary and fetches them, throttled (inter-call delay, per-run cap,
  refreshes the token on expiry, stops on a 429). Idempotent; re-run to continue.

### Notes
- Migration 0015 is additive (back-compat safe); auto-runs on deploy.
- Streams logic is unit-tested on synthetic data; the live Strava round-trip
  (endpoint shape, real per-app rate budget) is verified on first real use.
- Reconciles the M1 `activity_analyses` "streams-based zone distribution
  deferred to M2" note — M2 trait synthesis (KER-44) reads from here.

## [0.5.0] — 2026-06-08 — Grounded Coach (Phase 2: the coaching brain)

Makes MARP read your week like a coach instead of a logger. Two halves: a
deterministic adherence engine (what you were prescribed vs what you actually
did) and a holistic end-of-week evaluation that uses it.

### Added
- **Adherence engine** (`plan/adherence.ts`): joins each prescribed session to
  your actual activities by local calendar day + discipline, classifying every
  one as done / short / over / wrong-discipline / missed / upcoming, plus
  unplanned extras. This kills the "ran 5k of a prescribed 10k long run, still
  called it a long run" bug — adherence is now a computed fact in the coaching
  context, not an LLM guess. The current training week is derived from the
  plan's `start_date` (no stored cursor → no migration, old plans just work).
- **Holistic weekly evaluation** (`weekly-evaluation.ts` + prompt): a
  coach-to-athlete read of the week — the result, what went well, the one thing
  to sharpen — reasoned across adherence, physiological signals (RPE / HR drift
  / splits), injury flags, and where you are in the block. Live now reactively:
  ask "how did my week go?" and you get the real evaluation.
- **Coach-decided plan adjustment**: when the evaluation judges next week should
  change, MARP applies the change and tells you what and why, with a one-tap
  revert ("keep it as it was"). Health red flags are surfaced and proposed,
  never auto-applied. The proactive end-of-week send + auto-apply ride the
  weekly sweep, gated behind `PROACTIVE_OUTBOUND` until the prod number is live.
- `weekly_evaluations` ledger (migration 0014): one row per athlete-week
  (idempotency) + the pre-change plan snapshot (revert).

### Changed
- The weekly scheduler tick now runs the evaluation sweep, **superseding** M1's
  weekly retro-proposal (the evaluation is the superset — it always gives a
  read and acts when warranted). M1's event-driven retro is unchanged.

### Notes
- Migration 0014 is additive (back-compat safe); auto-runs on deploy.
- Adherence fixtures are currently synthetic; a real week of dogfood data turns
  them real. Phase 3 (Strava streams depth, KER-80) deepens the evaluation next.

## [0.4.0] — 2026-06-08 — Grounded Coach (Phase 1: facts SSOT)

Kills a class of "MARP is lying about me" hallucinations. Root cause: the runner's
facts lived in three places at once (the `timezone` column, free-text in
`athletic_history`, and the last 20 chat messages), and the coaching LLM reconciled
them and guessed. The fix is a single source of truth for location and goal, stated
as an authoritative line in the context, plus a deterministic answer path for direct
profile questions.

A de-risk eval up front measured the problem honestly: with only the timezone in the
ground-truth line, a stale "moved to Tokyo" message in the chat log poisoned the
coaching reply **44% of the time**. After this phase: **0%**.

### Added
- **Location SSOT** — new `athletes.home_city` + `home_city_set_at` (migration 0013).
  The chat location-detector now classifies a permanent **move** vs a temporary
  **trip**: a move updates the home city + timezone; a trip shifts only the timezone
  (for reminders) and preserves home, so "where do I live" never drifts to a travel
  destination. Defaults to trip when ambiguous — a misread can't silently relocate you.
- **Resolved goal line** — one authoritative goal in the context with precedence
  (active race block's goal time > the onboarding target race), an explicit
  "do not invent a time" guard, and the race date preserved for plan sizing.
- **Deterministic profile readback** (`profile-readback.ts`) — "where do I live",
  "what's my goal", "what do you know about me" are answered straight from stored
  data with **no LLM in the loop**; edit intents ("update my profile") fall through
  to the router so the change actually happens.
- **`eval:grounding`** — a location-poisoning eval that is now the regression gate
  for this fix (0/9 clear cases poisoned).

### Changed
- The "Now (ground truth …)" context line states the resolved **home city** and
  tells the model to ignore other cities in the log; `target_race` and the plan are
  stripped from the raw history JSON so there's exactly one goal/location to read.
- Onboarding now persists the extracted city to the home-city SSOT, not just the
  timezone.

### Notes
- Migration 0013 is additive + nullable (back-compat safe); runs automatically on deploy.
- Phase 2 (plan-as-living-state + adherence) and Phase 3 (Strava depth) are tracked
  in Linear (KER-79, KER-80) under the Grounded Coach project.

## [0.3.0] — 2026-06-07 — v1.3 Trust & Safety

A two-layer safety guardrail that runs on **every** inbound message before any
coaching, so MARP never serves a training answer to someone describing a medical
emergency, a crisis, or a red-flag health situation. The design goal was a *durable*
guardrail: the worst cases must hold even when the LLM is wrong, slow, or down.

### Added
- **Safety triage** (`services/safety/triage.ts`, KER-29): runs first on every
  message, ahead of consent/onboarding/routing. Three tiers — `emergency`,
  `referral`, `none`. Emergency short-circuits to a scripted, region-aware help
  response (112/911 by country) and never reaches the coach; referral builds the
  normal reply with a hard professional-referral prepended. Recall-biased Haiku
  classifier (one retry), with a fail-safe to the deterministic floor — never to
  `none` — on any parse/LLM failure.
- **Deterministic floor** (`services/safety/deterministic.ts`): an LLM-independent
  layer of high-precision regexes for the unambiguous worst cases — self-harm,
  can't-breathe, collapse, seizure, stroke signs, severe bleeding, overdose, heat
  stroke, thunderclap headache (emergency); chest pain, purging/amenorrhea/food
  restriction (referral). It can only *escalate* the tier (`combineTriage` takes the
  higher of floor and LLM), so the guarantee holds with no model in the loop.
- **safety_events table + operator alert** (KER-32): best-effort audit row for every
  Tier-0/1 event (never blocks or alters the runner's reply) plus a fire-and-forget
  operator WhatsApp alert. The crisis reply is sent *before* logging/alerting.
- **Medical disclaimer + minor age gate** (KER-30): coaching context carries a
  not-a-doctor disclaimer, and runners under 18 get an age-appropriate safeguard
  (string-or-number age coercion so `"17"` is still gated).
- **Prompt hardening** (KER-31): ED / RED-S / under-fuelling / hydration guidance
  sharpened across the affected prompts; explicit self-harm phrasings named in the
  triage prompt so the LLM catches them too (defense in depth, not floor-only).
- **Safety eval gate** (`scripts/eval-safety.ts`, KER-33): ~31 must-catch fixtures
  (emergency + referral) plus controls. Gates on the **production** path
  (floor ⊔ LLM) with zero emergency misses and ≥95% recall, and reports LLM-alone
  recall alongside as a classifier-drift signal. Current run: 25/25 production,
  25/25 LLM-alone, 0 emergency misses, 0 controls over-flagged.

### Migration
- `0012_flowery_husk.sql` — `safety_events` (auto-runs on deploy).

## [0.2.0] — 2026-06-07 — M1 Adaptive Coaching Brain (dark launch)

The feedback loop that makes MARP's coaching adaptive rather than static. Shipped
**dark**: all proactive *outbound* is gated off behind `PROACTIVE_OUTBOUND` (default
off), so this release is behavior-safe — it silently builds the analysis/feeling data
and exercises the loop in production without sending anything on the (not-yet-verified)
WhatsApp number. Sending flips on at the real launch (Twilio production sender +
approved templates).

### Added
- **Post-run analysis** (`run-analysis.ts`): on a new Strava run, compute an objective
  read in code from the splits already in `raw_payload` (per-km pace, first/second-half
  pace drift, HR drift, split pattern — zero extra Strava API calls), then an LLM writes
  a one-line coach's read. Non-fatal on LLM failure.
- **Post-run check-in** (`check-in.ts`): a varied, run-specific "how did it feel?",
  decoupled from analysis. Gated outbound.
- **RunFeeling extraction** (`run-feeling.ts`): turns the runner's free-text reply into
  structured effort/RPE, energy, pain, adherence, context — grounded in the objective
  read. Cost-guarded (LLM only when a run is in the last 48h). Pain is recorded; injury
  flags stay owned by the existing flag-detector (no duplicates).
- **Proactive weekly retro** (`run-retro.ts`): a pattern detector that reads the week's
  signals + flags, decides whether the plan should change, and *proposes* via the
  existing decision-frame/binder — never auto-applies. Weekly sweep on the in-process
  tick + event-driven on strong signals; idempotent. Confirm → apply feeds the existing
  `adjustPlan`.
- **Target RPE (1–10)** on prescribed sessions in the plan-generator + training prompts,
  so prescription and the post-run feeling speak one scale.
- **Schema:** `activity_analyses` + `plan_adjustments` tables (migration `0011`).
- **Evals** for the three new prompts (`eval:m1`), retro-proposal gets the deepest set;
  full-loop E2E + a CRITICAL regression for ingest-trigger idempotency.

### Security / privacy
- GDPR Article 17: both new tables cascade-delete on athlete erasure (covered by the
  existing single-DELETE path). CSO review passed (0 critical/high).

### Notes
- DB migration `0011` is additive (two new tables) and auto-runs on Railway deploy.
- `PROACTIVE_OUTBOUND=on` is required to actually send check-ins/retro proposals; left
  off in this release.
