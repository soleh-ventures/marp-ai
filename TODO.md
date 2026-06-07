# Backlog

**The backlog lives in Linear, not here.** Team **Kerais** (`KER`) — https://linear.app/kerais

This file used to hold a duplicate task list; every open item now has a Linear issue, so it
was collapsed to a pointer (2026-06-06) to stop the two lists drifting apart. Add new backlog
items to Linear, under the matching project.

## Project map

| Project | What it is |
|---|---|
| **Validation** | User research + first paid sale + cycle-offer copy testing (KER-26–28). |
| **v1.3 Trust and Safety** | Safety-triage classifier, disclaimers, prompt hardening, red-flag evals, flywheel Phase 0 (KER-29–34, in progress). |
| **v1.4 Cycle-awareness** | Sex normalization, cycle detector, phase derivation, expert review (KER-35–38). |
| **M1 — Adaptive Coaching Brain** | The brain-first wedge: post-run analysis + check-in, RunFeeling capture, proactive weekly retro, evals (KER-60–71). **KER-39 (production Twilio) is the enabler — blocks the proactive pieces.** |
| **v1.5 Proactive enrichment** | Weather + delight touches (KER-40–42). (Production Twilio sender moved to M1 as KER-39.) |
| **v1.6 Flywheel matures** | Adherence-detection job, trait synthesis, run stories, full LLM eval suite (KER-43–46). Several items are layered on M1 (see links). |
| **v1.7 Ingest and breadth** = **M2** | Open Wearables recovery (Whoop/Oura), vision extract/correct/eval, FIT/TCX, calendar life-context (KER-47–52). |
| **v2.0 Scale and monetization** = **M3** | Billing, cohort priors, observability dashboard, safety hardening (KER-53–56). |

## Milestone ↔ roadmap mapping (from 2026-06-06 office-hours)

- **M1 Adaptive coaching brain** → the M1 project (+ KER-39 enabler).
- **M2 Recovery data layer** → v1.7 (Open Wearables, Whoop/Oura first).
- **M3 Web app + account model + coach console + pricing** → v2.0 (billing) + new web work (not yet ticketed).
- **M4 Dashboard + Garmin + native-iOS Apple Health** → later (observability dashboard KER-55 is the internal precursor).

## Already shipped (do not re-add)

- **Periodized planner** (`generatePlan`, `src/services/plan/`) — the old "T8 periodized planner" TODO; shipped in v1.1–v1.3.
- End-of-block narrative summarization (`src/memory/summarize.ts`).
- Auto-flag detection (`src/services/flag-detector.ts`).
- In-process reminder scheduler, ICS/calendar export, timezone ladder.

## Cross-cutting dependency to watch

**Production Twilio sender (KER-39)** gates *all* business-initiated WhatsApp: the M1 post-run
check-in (KER-62) and weekly retro (KER-64), the v1.5 proactive/weather/delight items, and the
already-shipped daily reminder scheduler. On Twilio Sandbox only replies-within-24h work. Land
KER-39 early — Meta Business verification has lead time.
