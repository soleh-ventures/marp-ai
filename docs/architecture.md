# Architecture

How a single WhatsApp message becomes a personalised coaching reply, end to end.

This is the **why-it-works** document. For each subsystem's internals, read the linked reference docs.

---

## End-to-end request flow

```
                    Runner
                      │
            sends "knee feels off"
                      │
                      ▼
                ┌──────────┐
                │  Twilio  │
                └────┬─────┘
                     │ POST /webhooks/twilio/whatsapp
                     ▼
            ┌────────────────────┐
            │ src/webhooks/      │
            │ twilio.ts          │  signature verify (HMAC-SHA1, constant-time)
            │                    │  claim by MessageSid (idempotency)
            │                    │  findOrCreateByPhone → athlete row
            │                    │  insert inbound message row
            │                    │  return 200 + empty TwiML
            └──────────┬─────────┘
                       │ fire-and-forget
                       ▼
            ┌────────────────────────────────────────┐
            │ src/services/process-incoming.ts       │
            │                                        │
            │  1. Deletion confirmation check?       │
            │  2. Consent gate (Article 6)           │
            │  3. Dormancy check                     │
            │  4. File ingest (if media attached)    │
            │                                        │
            │  Pre-routing batch (parallel):         │
            │  ┌──────────────────────────────────┐ │
            │  │ binder.bindReply                 │ │
            │  │ flag-detector.detectFlags        │ │
            │  │ summarize.autoTransitionBlocks   │ │
            │  └──────────────────────────────────┘ │
            │                                        │
            │  Branch:                               │
            │  • Deletion request?    → confirm     │
            │  • Onboarding pending?  → onboarding  │
            │  • Strava connect?      → magic link  │
            │  • Default              → router      │
            └──────────┬─────────────────────────────┘
                       │
                       ▼
            ┌────────────────────────────────────────┐
            │ src/router/index.ts                    │
            │                                        │
            │  classify(message)                     │
            │      ↓                                 │
            │  domains = [training, injury, ...]     │
            │      ↓                                 │
            │  Promise.all(domains.map(runDomain))   │
            │      ↓                                 │
            │  if (1 domain) finalText = its reply  │
            │  else synthesize(...)                 │
            │                                        │
            │  decision_frame extracted from reply   │
            │  (one-shot retry on malformed)         │
            └──────────┬─────────────────────────────┘
                       │
                       ▼
            ┌────────────────────────────────────────┐
            │ src/services/twilio-send.ts            │
            │  → POST to Twilio REST API             │
            └──────────┬─────────────────────────────┘
                       │
                       ▼
                    Runner
            (sees the reply)

            Meanwhile:
            ┌────────────────────────────────────────┐
            │ outbound message row persisted         │
            │ pending_decisions row written if frame │
            └────────────────────────────────────────┘
```

---

## Why the pre-routing batch runs in parallel

Three independent jobs need to happen on every inbound:

1. **Binder** — does this runner reply resolve a pending decision MARP previously asked? (Quick DB hit; an LLM call only if no exact match.)
2. **Flag detector** — does this message mention a new persistent context flag (injury, illness, travel)? (Always one Haiku call.)
3. **Auto-transition** — has any active race block's race date passed by 7 days? If so, transition + summarise. (Always one DB query; LLM call only if a stale block exists.)

They don't observe each other; they touch different tables. Running them with `Promise.all` saves the worst-case sequential ~1 s. Errors are caught per-task so one failing doesn't block the others.

Why *before* the routing branch and not after: the binder and flag-detector writes need to be visible to `getMemoryContext`, which the router calls. The runner says "my Achilles is sore" → flag-detector creates the row → `getMemoryContext` lists it → MARP can acknowledge in **this** turn's reply, not the next one.

---

## Why the synthesizer is conditional

Two LLM call patterns:

- **Single domain** (~80% of messages): classifier picks one domain. The domain reply *is* the final reply. Two LLM calls total (classifier + domain).
- **Multi-domain** (~20% of messages): classifier picks 2+ domains. Each runs in parallel; the synthesizer reconciles them into one MARP voice. `1 + N + 1` LLM calls.

A skipped synthesizer step on the common case saves ~$0.002 and ~600 ms of latency per request. The single-domain output is already in MARP's voice (each domain prompt has the voice rules baked in); a synthesizer pass would only rephrase.

---

## Why we cache the system prompt

Anthropic's prompt-cache API charges 10% of input rate for cache-read tokens after the first call. The system prompts for the eight LLM components (classifier + 6 domains + synthesizer + binder + flag-detector + summarizer) are long (200–1500 tokens each) and stable across calls. Cache-read = 90% off on those tokens.

`config.llm.cacheSystem: true` on every `LlmRequest`. The provider injects the `cache_control: { type: "ephemeral" }` marker. The 5-minute idle TTL means a warm prompt stays cached across the few seconds between back-to-back runner messages.

Caching telemetry: `llm_calls.cache_hit` + `llm_calls.cache_read_tokens`. Cost estimate splits the regular and cache-read portions so the dashboard shows real spend, not pre-caching estimates.

See: `docs/reference/llm-pipeline.md`.

---

## Why memory is structured, not just a chat log

MARP's "remembering" feels conversational but it's powered by typed rows, not concatenated history:

| Memory type | Storage | Read on every reply? |
|---|---|---|
| Profile | `athletes.athletic_history` (jsonb) | Yes |
| Active flags (injuries etc.) | `active_flags` table, unresolved | Yes |
| Active race block | `race_blocks` WHERE state='active' | Yes |
| Past block narrative summaries | `race_blocks.summary` WHERE state='completed' | Yes (3 most recent) |
| Recent activities | `activities` (last 14) | Yes |
| Recent conversation | `messages` (last 20, oldest-first) | Yes |
| Pending decisions | `pending_decisions` WHERE resolved_at IS NULL | Read by binder |
| Strava connection status | derived from `strava_connections` | Yes (as one explicit line) |

Why not just "stuff the chat history into the prompt"? Three reasons:

1. **Token cost**: 6 months of WhatsApp chatter is tens of thousands of tokens. Typed memory plus a 20-message tail keeps the prompt < 4k tokens.
2. **Recall accuracy**: Asking the LLM "what injuries does this runner have?" from raw chat is unreliable. A flat list of unresolved flag rows is deterministic.
3. **Auditability**: GDPR Article 15 export needs to enumerate everything we hold; typed rows are queryable, embedded text in a 50-turn conversation isn't.

See: `docs/memory-model.md`.

---

## Why the binder exists

The original failure mode: MARP asks "rest or easy 5K today?" → runner replies "rest" → MARP acknowledges in a single turn but never *remembers* what choice was made. Next time the runner asks about the week, MARP has no idea they took a rest day on purpose.

The binder closes the loop. Three steps:

1. Domain or synthesizer emits a `<decision_frame>` block at the tail of the reply (when the classifier flagged `is_fork=true`). Stripped before send. Persisted to `pending_decisions`.
2. On the next runner reply, the binder reads open frames. Stage 1: regex/string match against option keys + labels. Stage 2 (fallback): Haiku call with the strict prompt "return null if uncertain."
3. On match: atomic write to `pending_decisions` (`resolved_at`, `resolved_key`) + `messages` (`resolves_pending_decision_id`). The next memory context can surface what was decided.

Hallucination guard: the LLM's returned key MUST be one of the frame's option keys; anything else is dropped. False positives are worse than false negatives — better to leave the frame open and let the runner reclarify than silently invent a decision they didn't make.

See: `docs/reference/binder.md` (deferred — read `src/services/binder.ts` and `prompts/decision-binder.md`).

---

## Why consent comes BEFORE everything

GDPR Article 6 needs a lawful basis to process personal data. For a consumer service, that's almost always explicit informed consent. A runner texting MARP is *expressing interest*, not consenting.

Implementation: `athletes.consent_granted_at` (nullable). On every inbound, before the dormancy check, before the pre-routing batch, before any routing — if it's NULL:

- If the last outbound wasn't the privacy notice → send the notice, return.
- If the last outbound was the notice and the runner replied "yes"-ish → grant consent, ask the first onboarding question.
- If they replied "stop"-ish → archive the athlete, send a respectful close.
- If ambiguous → re-send the notice.

The privacy notice is in `src/services/consent.ts`, locked by tests so the copy doesn't drift (we test that it surfaces the right-to-delete, names what data we collect, names what we don't do, and asks for explicit YES).

See: `docs/privacy.md`.

---

## Why Strava events lack signatures

Strava's webhook API has **no HMAC-signing mechanism**. Their security model is "the URL is known only to the subscription owner." Anyone who learns our public webhook URL can POST forged events.

Three layers of defence:

1. **Subscription ID guard** — every event's `subscription_id` must match the one we registered at bootstrap. Stored in `strava_webhook_config`, cached in-process after first hit.
2. **Owner ID lookup** — every event's `owner_id` is matched against `strava_connections.strava_athlete_id`. Unknown owners → silent no-op.
3. **Real activity fetch** — for `aspect_type=create|update`, the handler calls Strava's REST API with the runner's actual OAuth token to fetch activity details. A forged `object_id` would fail the fetch.

We always ack 200 to avoid Strava retry storms; rejected events log a warning and skip processing. Mismatches are visible in Railway logs (`strava webhook event REJECTED: ...`).

See: `docs/strava-integration.md`.

---

## Why the database has cyclic FKs

`messages.resolves_pending_decision_id` → `pending_decisions(id)` → `pending_decisions.message_id` → `messages(id)`.

Both directions are needed:

- The binder needs to know which inbound message resolved a frame (`resolves_pending_decision_id`).
- Memory queries need to know which outbound originally posed the question (`message_id` on the frame).

Drizzle handles the cyclic forward-declaration via `(): AnyPgColumn => …`. Insert ordering follows the natural flow (outbound message → pending decision → eventually a resolving inbound), so no deferred constraints needed.

ON DELETE behaviour:

- `messages.resolves_pending_decision_id` → `SET NULL` (the inbound stays in conversation history even if the frame is deleted)
- `pending_decisions.message_id` → `SET NULL` (the frame's audit record survives outbound moderation)
- `pending_decisions.athlete_id` → `CASCADE` (GDPR erasure removes everything)

---

## Why we don't use a queue

The webhook handlers run `processIncomingMessage` and the Strava activity handler as fire-and-forget background tasks. Single Railway replica, single process. No Redis, no BullMQ, no Kafka.

Why this is fine at v1 scale:

- Single-runner conversations are sequential. Twilio's MessageSid claim ensures the same message isn't double-processed.
- A process crash mid-task loses one in-flight reply. Twilio doesn't retry — we accepted the message and replied with empty TwiML — but the next runner message naturally re-engages the flow.
- LLM calls don't block the webhook 200 ack. The 2 s Twilio webhook timeout is not at risk.

Why this becomes inadequate at scale:

- 50+ concurrent runners would oversubscribe Anthropic rate limits.
- A spike of Strava webhook deliveries (Saturday afternoon when half the long-runs land) needs back-pressure or pacing.

ET12 in the original eng-review spec was an in-memory FIFO queue with 1.5 req/s spacing for Strava fetches. Not implemented in v1; deferred.

---

## Module boundaries

```
src/
├── webhooks/          ← HTTP entry points (twilio, strava)
├── routes/            ← OAuth callback routes (strava-auth)
├── services/          ← Business-logic surfaces
│   ├── llm/           ← Provider abstraction (anthropic, mock)
│   ├── athletes.ts
│   ├── consent.ts
│   ├── binder.ts
│   ├── flag-detector.ts
│   ├── pending-decisions.ts
│   ├── strava-*.ts    ← OAuth + tokens + activities + backfill + subscriptions
│   ├── erasure.ts     ← GDPR Article 17
│   ├── dormancy.ts
│   ├── phone-redact.ts
│   ├── thinking-ack.ts
│   ├── process-incoming.ts  ← The orchestrator
│   └── twilio-send.ts
├── router/            ← Classifier + domain runner + synthesizer
├── memory/            ← getMemoryContext + summarize (block summarization)
├── ingest/            ← File upload (GPX) parsing
├── flows/             ← Onboarding state machine
├── middleware/        ← Rate limiter
├── db/                ← Schema + client + test guard
└── scripts/           ← Admin CLIs (delete, summarize, export, strava bootstrap)

prompts/               ← LLM persona prompts (eight + binder + flag-detector + summarizer)
drizzle/               ← Generated SQL migrations
```

The boundaries that matter for understanding the code:

- `webhooks/` does NO business logic. It verifies signature, persists the inbound, returns 200, and hands off.
- `services/process-incoming.ts` IS the orchestrator. Every routing decision lives there.
- `services/llm/` is the only place that calls Anthropic. Cost / telemetry / cache flow through `services/llm-call.ts`.
- `memory/retrieve.ts` is the only function that builds the LLM context string. Every domain / synthesizer call uses its output.

---

## Related docs

- `docs/prd-v1.md` — what v1 is and isn't
- `docs/memory-model.md` — what we remember and how
- `docs/privacy.md` — GDPR posture
- `docs/strava-integration.md` — OAuth + webhook + backfill
- `docs/reference/admin-scripts.md` — operator CLIs
