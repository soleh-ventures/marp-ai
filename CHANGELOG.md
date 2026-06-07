# Changelog

All notable changes to marp-ai are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver in `package.json`.

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
