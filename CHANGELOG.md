# Changelog

All notable changes to marp-ai are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver in `package.json`.

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
