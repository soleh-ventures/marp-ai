# TODO — post-v1 backlog

Tasks not shipped in v1, ordered by UX + functionality impact. Move items back to active work as priorities shift.

A note on naming overlap: two items from the original spec ("T8 periodized planner" and "T11 delight touches") share numbers with tasks shipped under different scopes during the build:

- **T8 shipped** = end-of-block narrative summarization (`src/memory/summarize.ts`). Different from "T8 periodized planner" below.
- **T11 shipped** = auto-flag detection (`src/services/flag-detector.ts`). Different from "T11 delight touches" below.

The originally-numbered planner and delight features are still open. Listed here under their original names for continuity.

---

## Tier 1 — Small UX wins, ship soon

### T11 — 6 delight touches

**What**: Six small moments of warmth or personality scattered through the flow — examples (concrete ideas, not a final list):
- Birthday recognition (if we know it from onboarding)
- "First long run since [the injury flag resolved]" callout
- Streak acknowledgement after N consecutive training weeks
- Race-week countdown moments (T-7, T-3, race morning)
- Recovery-day permission ("rest is the work today")
- Welcome-back warmth after a long gap (currently the dormancy challenge is functional but not warm)

**Why**: MARP's competitive edge is feeling like a person who knows you, not a generic chatbot. These cost almost nothing to add and compound the "MARP remembers" thesis we already shipped.

**Effort**: ~1.5–2 hr per touch × 6, but most are simple trigger + canned-copy patterns. Could be shipped one at a time, not as a single PR.

---

## Tier 2 — Functionality runners explicitly ask for

### T8 — Periodized planner

**What**: A multi-step plan generator that takes the athlete's profile + race date + current fitness and emits a full periodized plan (base → build → peak → taper) with weekly mileage targets and key workouts. Today the training domain prompt discusses periodization principles and the LLM can describe a plan in chat, but there's no structured plan output stored in `race_blocks.plan` (the column exists, empty).

**Why**: Runners ask "give me a plan" as one of the most common first requests. Conversational advice is useful, but a concrete schedule is what they're paying for.

**Effort**: ~6–8 hr. Needs:
- A planner LLM call with the right inputs (athlete profile, race info, fitness from recent activities, flags)
- Structured JSON output (weeks × workouts) persisted to `race_blocks.plan`
- Memory retrieval surfaces the current week's planned workouts
- Possibly a chat command ("show me this week") to render the plan

---

### T10 — Content gen (run stories)

**What**: After an activity lands (via Strava webhook, GPX upload, or backfill), generate a short narrative — "Saturday's long run: solid 21k in 1:55, HR mostly Z2, lost the front of the pack at km 18 when the hill kicked in." Sent unprompted? Or surfaced on the next inbound? Either works.

**Why**: Engagement layer. Strava already provides activity data; MARP's job is to interpret it. A runner who gets a thoughtful read on their workout each time is more likely to keep the app on.

**Effort**: ~2–3 hr. New service `src/services/run-story.ts` triggered from `ingestStravaActivity` and `ingestFileFromMediaUrl`. Sonnet call with the activity + recent context. Send via Twilio or stash for the next inbound.

---

## Tier 3 — Vision capability (separate lane)

### ET16 — Vision extract

**What**: Sonnet-vision call against runner-uploaded photos / screenshots. Extracts structured data (discipline, distance, duration, HR) from Garmin / Apple / Strava activity screenshots, treadmill control panels, race results, and coach-issued training plans.

**Why**: Strava covers high-frequency data; vision covers the long tail (non-synced workouts, coach plans, screenshots from devices that don't export GPX).

**Effort**: ~1.5 hr.

**Files**: `src/services/vision-extract.ts`, `prompts/vision-extract.md`, plus a new image branch in `src/webhooks/twilio.ts`.

---

### ET17 — Correction loop

**What**: After vision extracts an activity, the runner can reply within 5 min "actually distance was 14.5" → parser detects the partial-update intent → merges into the just-persisted activity row.

**Why**: Vision is non-deterministic. Without a fix path, a misread either lives forever or forces a delete-and-restart. Correction is the trust mechanism.

**Effort**: ~1 hr. Depends on ET16.

---

### ET20 — Vision eval suite

**What**: 20 hand-labeled fixture images (Garmin / Strava / Apple / treadmill / race / non-workout). Eval gate ≥ 80% pass on discipline + distance / duration / HR within tolerances.

**Why**: Vision LLMs hallucinate confidently. The eval suite *is* the gate that lets us tune vision prompts safely. Without it, "vision works" is opinion not fact.

**Effort**: ~3 hr human (labelling images) / ~30 min Claude Code for the runner script. Depends on ET16/17.

---

## Tier 4 — Quality + operations infrastructure

### T12 — LLM eval suite

**What**: Structured evals across the LLM stack — classifier accuracy on labelled routing fixtures, domain output quality grading, synthesizer reconciliation correctness on multi-domain inputs, binder match precision/recall. Today we have `src/router/prompts.test.ts` (prompt-on-disk shape checks) and the "cite the principle" assertion (ET18) but no output-quality eval.

**Why**: Quality regressions from a prompt tweak or model upgrade are silent without this. Right now the only feedback loop is real runners noticing.

**Effort**: ~4–6 hr — eval harness + fixture seeding + a runner script. Pays off over months of prompt iteration.

---

### T15 — Observability dashboard

**What**: A simple HTML page (Hono server-rendered or static + fetch from `/api/admin/*`) showing:
- Daily inbound message count, athlete-active count
- Per-component LLM cost (last 7d, 30d), with cache_hit% surfaced
- Median + p95 latency per component
- Activity ingest rate (Strava webhook + GPX uploads)
- Open `pending_decisions` count, resolution rate

**Why**: We have the data in `llm_calls`, `messages`, `activities`. Right now you read it with ad-hoc SQL. A dashboard makes anomaly detection passive instead of active.

**Effort**: ~6–8 hr. Could be a static React + a few admin-only API endpoints, or a server-rendered Hono template.

---

## Tier 5 — Low-frequency ingest fallbacks

### ET15 — FIT / TCX parser

**What**: Extend `src/ingest/file.ts` past GPX to also parse FIT (Garmin binary) and TCX (XML). Currently both return a friendly reject pointing the runner to GPX export.

**Why**: GPX already covers every well-formed export from Garmin / Strava / Apple / Wahoo / Polar. FIT and TCX add coverage for the small set of devices that don't expose GPX, but it's a long tail.

**Effort**: ~2–3 hr (FIT needs a parser library; TCX is XML and would reuse the GPX patterns).

---

## Tier 6 — Operational hygiene

### O1 — Retention sweep for llm_calls I/O text

**What**: A scheduled job that NULLs `input_user` / `output_text` on `llm_calls` rows older than N days (start ~30), while keeping the cost/token/latency/cache columns for long-term aggregate analytics. Mirror the existing reminder-runner shape (`src/scripts/run-reminders.ts`) or fold into an admin script.

**Why**: We now capture full prompt I/O for answer-quality debugging (PR adding `input_user`/`output_text`). That text holds PII and grows unbounded — useful for days, a liability for years. Erasure already scrubs it per-athlete on deletion; this caps the steady-state exposure for everyone else. Until this ships, the table accumulates PII indefinitely.

**Effort**: ~1–2 hr (one UPDATE on an indexed `created_at`, plus a cron entry).
