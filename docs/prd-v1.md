# MARP AI — Product Requirements Document, v1

**Status**: Shipped (master, June 2026)
**Author**: Engineering + product, built incrementally across PRs #1–#19

---

## What MARP is

MARP is a **personal AI running companion** — one relationship covering every domain a runner actually navigates: training, mental, nutrition, injury, recovery, and gear. It learns the runner's story over time and walks beside them through it, proactively when it matters and quietly when it doesn't.

The product hypothesis: runners don't need another generic plan or another fragmented app per discipline. They need **one companion that knows them deeply and adapts continuously**, so they reach their goals *mindfully and happily* — not just faster, but in a way that's sustainable, joyful, and grounded in who they are.

---

## The problem

A runner training for a goal race today is fragmented across:

- A **training app** that gives the same plan to everyone
- A **nutrition app** that doesn't know they're injured
- A **physio** they see when something already hurts
- A **friend or coach** they only talk to occasionally
- A **mental health practitioner** they don't see at all

Each surface is reactive (you ask, it answers) and isolated (it knows its slice, not your whole context). The result is a runner doing the integration themselves: holding the injury in one part of their head, the nutrition in another, the schedule in a third — usually badly, usually under stress.

MARP is the first version that holds **all of it in one place**:

- **Profile** — who you are, what you've done, what you're training for
- **Recent training** — what you've actually run, fed back from Strava and your uploads
- **Open threads** — the achilles that's been bugging you, the trip next week, the question we asked but haven't answered yet
- **Domains** — six experts on call (training, mental, nutrition, injury, recovery, gear) that speak in one voice

And it's **proactive**: when an active race block ends, MARP summarises what worked and what broke and carries that forward. When a runner mentions a new injury mid-conversation, MARP captures it and uses it in the next reply. When a decision MARP offered hasn't been resolved, MARP knows it's still open.

WhatsApp is the delivery channel — no app, no login, always-on — but the thesis is the holistic, personalised, proactive companionship itself.

---

## Target user

**Primary**: an English-speaking runner training for a goal race (5K → marathon) who already uses Strava and is comfortable in WhatsApp.

Realistic profile slices:
- Returner: 35-year-old training for their first half after a 2-year break, anxious about doing it "right"
- Veteran: 42-year-old marathoner trying to qualify for Boston, frustrated with generic plans
- Beginner: 28-year-old running their first 10K, doesn't know what taper means

**Out of scope for v1**: elite athletes (need structured periodisation tooling we haven't built), non-English speakers, runners on Garmin Connect-only (no Strava).

---

## Core value proposition (one sentence)

> A personal AI companion across every domain a runner navigates — coach, mind, nutrition, injury, recovery, gear — that learns your story and walks beside you to your goals, mindfully and happily.

The compounding memory is what makes turn 50 feel different from turn 1. The holistic scope is what makes MARP feel like a companion rather than a chatbot. The "mindfully and happily" framing is the values layer: we're not optimising for PRs at any cost; we're optimising for runners who finish the cycle still in love with running.

---

## What's IN v1

### Conversation layer
- Multi-domain expert router: classifier picks one or more of six domains (training, nutrition, injury, mental, recovery, gear); each domain runs in parallel; a synthesizer unifies the voice when multiple domains fire
- Eight grounded prompts (six domains + classifier + synthesizer) with source-citation rules so the LLM names the framework it's drawing from
- Prompt caching on every system prompt (≈70% reduction in classifier/domain/synth input cost once warm)
- Cache-aware cost telemetry surfaced per LLM component

### Memory layer
- Athlete profile (name, locale, athletic history) captured during onboarding
- Recent activities (last 14) surfaced in every LLM context
- Active flags (injury, illness, travel, life events) — auto-detected from conversation, surfaced until resolved
- Active race block with days-to-race math
- Past-block narrative summaries — auto-generated when an active block's race date passes by 7 days, then carried forward as long-term memory
- Conversation history (last 20 messages, oldest-first)
- Strava connection status surfaced explicitly so the LLM never guesses

### Decision binder
- When domain or synthesizer offers a fork ("rest or easy 5K?"), the reply contains a structured `<decision_frame>` block
- Block is stripped from the runner-facing reply, persisted as a pending decision
- Runner's later reply gets matched against the open options: regex on the option keys/labels first, Haiku LLM as a free-form fallback
- Resolution writes back to both `pending_decisions` and `messages.resolves_pending_decision_id` atomically
- One-shot retry if the LLM emits a malformed frame

### Onboarding
- Privacy notice as the first outbound (GDPR Article 6 informed consent)
- YES gates the onboarding flow; STOP archives the athlete with no data retained
- Conversational onboarding extracts name, race target, athletic history, constraints across ~3–5 turns
- Strava connect offer attached to the final onboarding reply

### Activity ingest
- Strava OAuth: HMAC-signed magic links, AES-256-GCM token encryption at rest, 5 min token TTL
- Strava webhook: subscription_id origin guard, idempotent dedup via (source, source_id), ingests on both `create` and `update` events (some manual entries arrive as `update`)
- Strava backfill: 60 days on connect, single API call via the summary endpoint
- GPX file upload via WhatsApp media: Haversine distance from trackpoints, discipline mapping (Running → run, etc.), idempotent against the media URL

### Privacy / compliance
- GDPR Article 6: consent gate before any coaching content
- GDPR Article 15: data export CLI (`bun run admin:export-athlete <uuid>`)
- GDPR Article 17: erasure via cascade — admin CLI + in-chat "delete my account" command with confirmation
- GDPR Article 32: AES-256-GCM token encryption, phone-number redaction in logs, HMAC constant-time compare on signatures
- Dormancy detection: 90-day inactivity → re-auth challenge before resuming context

### Ops
- "Thinking" ack — if router takes > 5 s, send one short MARP-voice line so the runner knows we're alive
- Rate limit on `/auth/strava/*` (5 req/min/IP)
- LLM cost + latency telemetry per component, with cache_hit flag
- Idempotent webhook handlers (Twilio + Strava)
- Test guard against `TRUNCATE` on prod
- Three admin CLIs: delete athlete, summarize block, export athlete

---

## What's OUT of v1 (deferred to `TODO.md`)

| Item | Reason |
|---|---|
| T8 — Periodized planner | Structured plan generator; LLM can describe plans conversationally but doesn't persist a structured schedule |
| T10 — Run stories (per-activity narrative) | Engagement layer on top of Strava data |
| T11 — Six delight touches | Birthdays, streak callouts, race-week countdown |
| T12 — LLM eval suite | Output-quality grading across the stack |
| T15 — Observability dashboard | Replaces ad-hoc SQL queries on `llm_calls` |
| ET16/17/20 — Vision lane | Photo / screenshot ingest with correction loop |
| ET15 — FIT/TCX file parser | GPX already covers 95% of devices |

Full prioritisation in `TODO.md` at the repo root.

---

## Success metrics

Three groups: activation, engagement, quality.

### Activation
- **Onboarding completion rate**: % of athletes whose first inbound results in an onboarded athlete (consent granted + first 1–2 turns produce a non-empty `athletic_history`). Target ≥ 70% at v1, ≥ 85% once we tune the onboarding prompt.
- **Strava connect rate**: % of onboarded athletes who complete Strava OAuth. Target ≥ 50%.

### Engagement
- **D7 retention**: % of athletes who send a message in the 7 days after onboarding. Target ≥ 60%.
- **Messages per active week**: per-athlete median. Target ≥ 8 (signals real coaching cadence, not novelty).
- **Days from connect to first activity ingest**: measure of whether the data side works end-to-end.

### Quality
- **Reply latency p95**: time from inbound webhook receipt to outbound send. Target ≤ 10 s for single-domain, ≤ 20 s for multi-domain.
- **Cache hit rate**: `SELECT count(*) WHERE cache_hit / count(*)` on `llm_calls`. Target ≥ 50% once any prompt warms.
- **Binder match rate**: open `pending_decisions` resolved within 7 days. Target ≥ 70%.
- **Flag false-positive rate**: ratio of auto-flags the runner later contradicts ("no, my knee was fine"). Target ≤ 5%.

### Privacy / compliance
- **Pre-consent data exposure**: zero. Hard constraint, not a target.
- **Article 15 export turnaround**: median time from request to JSON delivered. Target ≤ 48 h (GDPR allows 30 days; we want to be much faster).
- **Article 17 erasure latency**: from runner "delete my account" → cascade complete. Target ≤ 1 min.

---

## Architecture choices

| Decision | Choice | Why |
|---|---|---|
| Channel | WhatsApp only | Lower friction than installing an app; runners already live there |
| LLM | Anthropic (Sonnet for domain/synth, Haiku for classifier/binder/flag-detector) | Cost / quality tier matching the call shape |
| Runtime | Bun + Hono | Cheap on Railway, fast startup, ergonomic for our LLM-heavy pipeline |
| Database | Postgres (Railway-managed) + Drizzle ORM | Structured memory; ORM keeps queries safe |
| Hosting | Railway, single replica | Simple, low ops cost for v1 |
| Strava integration | Webhook + REST API | Push-based for new activities; pull for backfill |
| Activity formats supported | Strava push + GPX upload | Covers ~95% of well-formed exports from major devices |

---

## Constraints / what we deliberately don't do

- **Single language**: English only. Multi-language adds prompt complexity we'll handle once we have a real signal a non-English market exists.
- **Single channel**: WhatsApp only. SMS / iMessage / Telegram are deferred.
- **Single device integration**: Strava only. Garmin Connect direct, Apple Health, Polar Flow would need their own ingest paths.
- **No structured plan generator yet**: training advice is conversational. Periodised plan output is in the v1.1 backlog.
- **No vision yet**: photos and screenshots aren't parsed; runners can describe in text.

---

## Risks

| Risk | Mitigation |
|---|---|
| LLM quality regression on prompt edits | T12 eval suite (deferred but called out) |
| Cost runaway on a viral spike | Prompt caching shipped; per-component cost telemetry surfaces the regression |
| GDPR complaint | Consent + Article 15 export + Article 17 erasure all shipped |
| Strava token leak | AES-256-GCM at rest; access tokens never logged |
| Dependency on Anthropic API uptime | LLM provider interface allows swap to OpenAI or others; not exercised in v1 |
| Twilio account suspension | No mitigation in v1; would need a backup channel |

---

## Open questions for v1.1

- Do we add Garmin Connect direct? Real demand signal from runners not on Strava would push this up.
- Do we ship the periodised planner before vision, or vice versa? Planner is more strategic; vision is more "wow."
- How aggressive should the auto-flag prompt be? Tighten if false-positive rate runs hot.

---

## Related documents

- `docs/architecture.md` — end-to-end request flow and component boundaries
- `docs/memory-model.md` — the data model that powers MARP's "remembering"
- `docs/privacy.md` — GDPR posture and admin workflows
- `docs/strava-integration.md` — Strava OAuth + webhook + ingest
- `docs/gtm/positioning.md` — who MARP is for, how we talk about it
- `TODO.md` — post-v1 backlog
