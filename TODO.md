# Deferred TODOs

Tasks pulled out of the active backlog with reasons + estimates. Move back when their pre-conditions are met.

## ET15 — FIT/GPX/TCX file parser

**Source**: gstack eng-review rev3 tasks (id `ET15`).

**What**: Runner-uploaded fitness files via Twilio MediaUrl; parse and persist as activities with `source=fit/gpx/tcx`.

**Why deferred**: Strava already covers the highest-frequency data source (devices that sync to Strava). FIT/GPX is the universal fallback for runners who don't use Strava at all (or use Garmin Connect directly without Strava sync). Worth doing once we see the demand.

**Files involved** (per spec):
- `src/ingest/file.ts`
- `src/ingest/file.test.ts`
- Hooks into `src/services/process-incoming.ts` (image / media branch)

**Effort**: ~1 hr human / ~20 min Claude Code.

## ET20 — Vision eval suite

**Source**: gstack eng-review rev3 tasks (id `ET20`).

**What**: 20 hand-labeled fixture images (Garmin / Strava / Apple / treadmill / race / non-workout). Eval gate ≥80% pass on discipline + distance / duration / HR within tolerances.

**Why deferred**: Depends on the vision lane (ET16 + ET17) shipping first. The eval suite *is* the gate that lets us tune vision prompts safely; without vision live, the gate is moot.

**Effort**: ~3 hr human (labeling images) / ~30 min Claude Code for the runner script.
