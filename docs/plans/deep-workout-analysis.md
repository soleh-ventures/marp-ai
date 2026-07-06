# Deep Workout Analysis — feed the coach the full time-series, not just averages

Branch: `soleh-ventures/fix-garmin-pipeline` → new branch · Target: `master` · Status: DRAFT (pre-review)

## Problem

The founder's complaint: "the AI is not so smart — it reads only heart rate and
avg pace, that's all. I want the coach to analyze each second/minute of the whole
training for deeper analysis."

He's right, and the cause is specific: the deep-analysis machinery already exists
but is starved of data. `src/services/strava-streams.ts` has a pure summarizer
(`summarizeStreams`) that turns per-sample channels into an `activity_streams`
row (per-km splits, split pattern, HR drift), and `run-analysis.ts:181` injects
that into the coach's context as *"Stream detail (AUTHORITATIVE — prefer this over
averages)."* But `activity_streams` is only populated for **Strava** activities
(`strava-streams.ts:223`), and Strava's API died 2026-06-28. The new **Garmin**
activities (ingested via the sidecar) carry only summary averages in
`activities.metrics` — avg/max HR, distance, pace, cadence, elevation. No streams
→ `run-analysis.ts` finds no `activity_streams` row → the coach falls back to the
averages. That is exactly "reads only HR and avg pace."

## Goal

Every Garmin activity gets a rich `activity_streams` summary computed from its
full per-second time-series + laps + HR-zone distribution, in the same shape the
coach already reads (extended with the channels Garmin gives). Result: "analyze
my run" and the post-run read produce per-segment insight — where you faded,
whether you negative-split, cardiac drift, cadence stability, time-in-zone,
lap-by-lap execution vs the session's intent — not just averages.

## What exists (verified in code)

- **`activity_streams`** table (`schema.ts:208`, KER-80): `summary` jsonb per
  activity, unique on `activity_id`. 17 rows in prod (all Strava). Design intent
  (schema comment): summarize at ingest, never store the raw time-series, never
  feed raw to the LLM.
- **`summarizeStreams(streams)`** (`strava-streams.ts`): PURE function, channels
  `time,distance,heartrate,velocity_smooth,altitude,cadence` → `StreamSummary`
  `{ km_splits[], split_pattern, hr_drift_pct, avg_hr, max_hr, total_distance_m,
  total_time_s }`. `renderStreamAnnotation(summary)` renders it for the LLM.
- **`run-analysis.ts:179-181`**: loads the stream summary for the activity and,
  when present, renders it as the AUTHORITATIVE block ahead of the average-based
  objective stats. Already source-agnostic — reads by `activity_id`, not source.
- **Garmin sidecar** (`garmin-sidecar/`): ingests activities (summary) +
  wellness. `garminconnect` 0.3.6 exposes `get_activity_details` (per-second
  samples), `get_activity_splits` / `get_activity_typed_splits` (laps),
  `get_activity_hr_in_timezones` (time-in-zone), `get_activity_weather`.
- **`weekly-evaluation.ts`** also reads the stream summary (second consumer).

## Scope

### 1. Fetch Garmin per-activity detail in the sidecar

For each newly-ingested Garmin activity (`ingest_activities`), pull:
- `get_activity_details(activityId, maxChartSize=…)` → per-sample arrays
  (timestamp, distance, HR, speed, altitude, cadence, power if present). Garmin
  returns `activityDetailMetrics` + a `metricDescriptors` index — map descriptors
  to channels.
- `get_activity_splits(activityId)` (or typed splits) → per-lap distance/time/HR.
- `get_activity_hr_in_timezones(activityId)` → seconds in each HR zone.
Best-effort per call (existing `_retry`/`safe` pattern); a detail failure must
never lose the activity row or the wellness ingest. Rate-limit aware (these are
extra Garmin calls per activity — throttle + only fetch detail for activities
missing a stream summary, so re-runs don't re-hit).

### 2. Compute the stream summary (shared shape)

Extend `StreamSummary` with Garmin-available channels the founder is asking for:
- `laps: [{ index, distance_m, time_s, avg_hr, avg_pace_s_per_km }]` (from splits)
- `hr_zones: [{ zone, seconds, pct }]` (from HR-in-timezones)
- `cadence: { avg, stability_cv }` (coefficient of variation = fade/inconsistency)
- `elev_gain_m`, `elev_loss_m`
- keep existing `km_splits`, `split_pattern`, `hr_drift_pct`, avg/max HR, totals.

**Architecture decision (for review):** where to compute the summary.
- **A. Port `summarizeStreams` to Python in the sidecar** — sidecar fetches
  detail, computes summary, writes `activity_streams` directly (it already writes
  the DB). Self-contained; DRY cost = the splits/drift math duplicated in Python,
  must match the TS `StreamSummary` shape exactly or `renderStreamAnnotation`
  breaks.
- **B. Sidecar posts normalized channels to a TS summarize endpoint** — reuse the
  existing pure `summarizeStreams` (no logic duplication); cost = a new internal
  endpoint + sidecar→app coupling + raw channels cross the wire.
- **C. Sidecar stores normalized channels in a scratch table; a TS job
  summarizes** — reuse TS logic; cost = raw time-series transiently in the DB
  (violates the "raw never stored" intent) + a second job.

### 3. Coach surfacing (mostly free)

`run-analysis.ts` already renders the summary when present — extending
`renderStreamAnnotation` to include laps/zones/cadence is the only change, and it
flows to both the post-run read and the on-demand "analyze my run". Also verify
the `looksLike…analysis` intent + memory context expose the richer read.

### 4. Backfill

One-off: fetch detail for the athlete's existing Garmin activities (last N) so
"analyze my last run" works immediately, not just for future runs.

## NOT in scope

- Real-time / live-during-run analysis (post-hoc only).
- ML/predictive models (VO2 trends, race prediction) — separate.
- Feeding raw per-second arrays to the LLM (the design forbids it; summary only).
- Power-meter deep analysis if the FR245 doesn't record power (degrade gracefully).

## Open questions (for the review pipeline)

- Compute location (A/B/C above) — DRY vs sidecar-self-containment vs raw-storage.
- HR zone boundaries: use Garmin's own zones, or derive from max/threshold HR?
- Backfill depth + Garmin rate-limit budget (detail = 1-3 calls × N activities).
