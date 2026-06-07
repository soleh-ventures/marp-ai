# Privacy & GDPR

How MARP handles personal data — the design, the code, the operator workflows.

This document is **both reference (what's implemented) and explanation (why)**. It maps each GDPR article we care about to its supporting code and operational procedure.

---

## What personal data we hold

Per athlete (linked by `athletes.id` UUID):

| Data | Where | Why |
|---|---|---|
| Phone number (E.164) | `athletes.phone` | Twilio uses it to route inbound + outbound; the natural key for the runner |
| Display name | `athletes.name` | Conversational warmth ("Hi Sarah…") |
| Locale | `athletes.locale` | Future internationalisation |
| Athletic history | `athletes.athletic_history` (jsonb) | Coaching context: years running, prior race times, weekly mileage, goals |
| Inbound + outbound messages | `messages` | Conversation memory for the LLM router |
| Activity data | `activities` + Strava raw payload in `raw_payload` jsonb | Training context; powers grounded coaching |
| Active flags | `active_flags` | Injury / illness / travel / life context |
| Race blocks | `race_blocks` (with narrative summaries) | Goal tracking + long-term memory |
| Strava OAuth tokens | `strava_connections` (encrypted at rest) | API access for ongoing activity sync |
| LLM cost telemetry + prompt I/O | `llm_calls` (cost cols anonymisable via `SET NULL`; `input_user`/`output_text` scrubbed on erasure) | Cost analysis (survives as aggregated stats) + answer-quality debugging (PII, removed on erasure) |
| Dedup state | `processed_messages` (Twilio SIDs) | Idempotency; opaque IDs without Twilio account access |

What we don't hold: payment methods (Twilio + Strava handle their own), real names beyond what the runner shares, location data beyond what's embedded in activity GPS traces.

---

## Article 6 — lawful basis for processing

**Implementation**: explicit informed consent.

Code path:

- `athletes.consent_granted_at timestamptz null` (migration 0007)
- `src/services/consent.ts` owns the privacy notice copy and the YES/STOP intent classifier
- `src/services/process-incoming.ts` gates every routing branch behind `consent_granted_at != NULL`. The check fires after deletion-confirmation (so a pre-consent runner can still abort) and before dormancy / pre-routing batch / onboarding / Strava / router.

The privacy notice copy (locked by tests in `src/services/consent.test.ts` so it doesn't drift):

```
Hi — welcome to MARP. Before we start, a quick honest note:

I save your messages, runs, and profile so I can coach you over time.
It's encrypted, stays with us, and never gets sold to anyone.

You can text "delete my account" anytime — instant wipe, no questions.

Reply YES to start. Reply STOP if this isn't for you.
```

State machine:

| Athlete state | Last outbound | Inbound matches | Next outbound | DB write |
|---|---|---|---|---|
| `consent_granted_at = NULL` | not the notice | (anything) | the notice | none |
| `consent_granted_at = NULL` | the notice | YES / YEAH / SURE / OK / AGREE | warm handoff + first onboarding question | `consent_granted_at = now()` |
| `consent_granted_at = NULL` | the notice | STOP / NO / CANCEL | "All good — your data won't be stored." | `athletes.archived_at = now()` |
| `consent_granted_at = NULL` | the notice | ambiguous | re-send the notice | none |
| `consent_granted_at != NULL` | (any) | (any) | normal routing flow | normal |

Test guarantees (`src/services/consent.test.ts`):

- Notice surfaces the right-to-delete in the same message
- Notice asks for explicit YES (no implicit consent)
- Notice names what data we collect AND what we don't do (sold)
- Accepted reply asks a question (so the runner isn't left hanging)
- Declined reply confirms data won't be stored
- Tight regex set for accept/decline; ambiguous → re-prompt

---

## Article 15 — right of access (data export)

**Implementation**: admin CLI.

```bash
bun run admin:export-athlete <athlete-uuid>            # → stdout JSON
bun run admin:export-athlete <athlete-uuid> --out path.json
```

Or against prod via Railway:

```bash
railway run -- bun run src/scripts/admin-export-athlete.ts <uuid>
```

Output structure (`src/scripts/admin-export-athlete.ts`):

```json
{
  "exportedAt": "2026-06-03T...",
  "gdprArticle": "Article 15 — right of access",
  "athlete": { "id": "...", "phone": "...", "name": "...", ... },
  "messages": [ { "direction": "in", "body": "...", ... } ],
  "activities": [ ... ],
  "activeFlags": [ ... ],
  "raceBlocks": [ ... ],
  "pendingDecisions": [ ... ],
  "stravaConnections": [
    {
      "id": "...",
      "stravaAthleteId": 12345,
      "scope": "activity:read_all,profile:read_all",
      "connectedAt": "...",
      "revokedAt": null,
      "encryptedAccessToken": "<redacted>",
      "encryptedRefreshToken": "<redacted>"
    }
  ]
}
```

**Strava tokens are redacted**. The runner is requesting *their* data (which connections exist, when, with what scope) — not the symmetric key material that protects access. Including the encrypted blobs would expose us to no benefit for them.

GDPR allows 30 days to respond to an access request; a CLI is sufficient for v1. A user-facing chat command ("export my data") is a candidate for v1.1.

---

## Article 17 — right to erasure

**Implementation**: cascade delete on the athletes row + two trigger paths.

### Cascade design

Every athlete-linked table has the right FK behaviour for erasure:

| Table | onDelete | Effect of athlete delete |
|---|---|---|
| `race_blocks` | CASCADE | removed |
| `activities` | CASCADE | removed |
| `active_flags` | CASCADE | removed |
| `messages` | CASCADE | removed |
| `strava_connections` | CASCADE | removed |
| `pending_decisions` | CASCADE | removed |
| `llm_calls` | SET NULL (`athlete_id`, `message_id`) + text columns scrubbed | row survives anonymised, PII text removed |

`llm_calls` deliberately survives, but in anonymised form. The row keeps token counts + model + latency + cost so aggregate cost telemetry isn't destroyed when one runner exercises Article 17. It also stores `input_user` + `output_text` (the prompt payload and model reply, captured for answer-quality debugging) — those hold PII, so `deleteAthlete` explicitly NULLs them before deleting the athlete (see `src/services/erasure.ts`). What survives is the cost skeleton, not the conversation.

`processed_messages` (Twilio SID dedup) is out of scope for v1 erasure — the SIDs are opaque without Twilio account access, and dropping them would risk re-processing a webhook retry as a new message. Revisit if a specific request requires it.

### Trigger 1: chat command (user-initiated)

Two-phase, no UI required:

1. Runner says "delete my account" / "forget me" / "remove my data" / similar
2. MARP replies with the confirmation prompt
3. Runner replies "YES DELETE" (exact phrase, case-insensitive)
4. MARP calls `deleteAthlete()` and sends a respectful close ("Your MARP account and all associated data have been deleted. Take care.")

State lives in the existing `messages` table — the binder for the confirmation phrase is "last outbound was the confirmation prompt." Same pattern as the dormancy NEW choice and consent decline.

Code: `src/services/erasure-intent.ts` + branch in `src/services/process-incoming.ts`.

### Trigger 2: admin CLI

```bash
bun run admin:delete-athlete <athlete-uuid>          # interactive confirm
bun run admin:delete-athlete <athlete-uuid> --yes    # for scripts
```

Prints a redacted summary (phone via `redactPhone` so the operator's terminal scrollback doesn't leak), waits for typed `YES`, then deletes. Use for legal requests that come in through email rather than via the chat command.

Code: `src/scripts/admin-delete-athlete.ts`.

---

## Article 25 — data protection by design

Three concrete patterns:

### Pseudonymisation in logs

`src/services/phone-redact.ts` exports `redactPhone(phone)` which keeps only the leading `+` and last 4 digits (`+***4567`). Used at every callsite where a phone might end up in operational output.

The webhook entry point in `src/webhooks/twilio.ts` includes a breadcrumb comment at `params.From` so future contributors know the rule: prefer the athlete UUID; fall back to `redactPhone()` only when the UUID isn't resolved yet.

Audit-clean: grepped `console.log/warn/error` across `src/`; only two pre-PR-#7 sites embedded raw phones (the dev seed script and the `findOrCreateByPhone` lost-race error). Both fixed.

### Pseudonymisation in DB references

Every cross-table FK uses the UUID, not the phone. Phone lives only in `athletes.phone`. Logs use the UUID.

### Minimisation at the prompt boundary

The LLM context includes athlete name + activity data + flag bodies + recent messages, but NOT the phone number. The phone is purely a Twilio routing detail, not coaching context.

---

## Article 32 — security of processing

### Strava token encryption at rest

`src/services/token-cipher.ts` implements AES-256-GCM:

- Key: 32 bytes, loaded from `STRAVA_TOKEN_ENCRYPTION_KEY` env var (64 hex chars). Fails loud at boot if missing or wrong length.
- IV: 96-bit random per call, prepended to ciphertext.
- Output: `base64(iv || ciphertext || auth_tag)`.
- Decrypt: AES-GCM verifies the auth tag; tampered ciphertext fails to decrypt.

Tokens are written by `upsertStravaConnection` (during OAuth callback or refresh) and read by `getFreshAccessToken` (which auto-refreshes near expiry).

### HMAC constant-time comparison

- Twilio signatures: `src/services/twilio-signature.ts` uses Node `timingSafeEqual` after base64 decode.
- Magic links: `src/services/strava-magic-link.ts` uses `timingSafeEqual` on the HMAC compare. 5-minute TTL on the signed payload (`athlete_id|expiry|nonce`).

### Rate limiting on the public auth endpoint

`/auth/strava/*` is rate-limited to 5 req/min/IP (`src/middleware/rate-limit.ts`). Sees `X-Forwarded-For` for the real client IP behind Railway.

This protects against token enumeration on the magic-link entry point. The token format (HMAC over a stable payload) means an attacker would have to guess athlete UUIDs within the 5-min TTL; the rate limit makes machine-speed enumeration uninteresting.

### Subscription-ID guard on Strava webhook

Strava doesn't sign webhook POSTs. The handler validates `event.subscription_id` against the one we registered at bootstrap (`strava_webhook_config.subscription_id`), cached in-process. Mismatched events are logged + dropped. See `src/webhooks/strava.ts` + `docs/strava-integration.md`.

---

## Article 33 — breach notification

Not implemented in v1. We don't have monitoring that would alert us to a breach in progress. Mitigations rely on:

- Railway-managed Postgres (provider-side ops)
- Token encryption (limits blast radius of a DB compromise)
- Rate limiting (makes mass exfiltration via the auth endpoint slow)

A real breach-notification process would need an audit log (admin actions, suspicious-access detection) and a runbook. Out of scope for v1 — flagged in the post-launch review as a Tier 4 follow-up.

---

## Article 5 — storage limitation

Not yet enforced via automated retention. Today:

- Messages live forever (until athlete erasure)
- Activities live forever
- `llm_calls` lives forever (cost columns anonymised on athlete delete)
- `llm_calls.input_user` / `output_text` hold PII and currently persist for non-deleted athletes until a retention sweep runs (tracked as TODO O1)

A retention policy (e.g., soft-delete messages older than 2 years; sweep `llm_calls` I/O text after ~30 days, archive cost rows after 1 year) is a clean follow-up. The I/O-text sweep (TODO O1) is the higher-priority one since that column is the only place PII accumulates unbounded.

---

## Operator runbook

### Article 15 request received

1. Verify the request comes from an authenticated source (the runner's known phone or a legal channel). MARP doesn't currently authenticate access requests — operator-side verification is the v1 plan.
2. Look up the athlete by phone:
   ```bash
   railway run -- bun -e "
     const { db } = await import('./src/db/client.ts');
     const { athletes } = await import('./src/db/schema.ts');
     const { eq } = await import('drizzle-orm');
     console.log(await db.select({id: athletes.id, name: athletes.name, createdAt: athletes.createdAt}).from(athletes).where(eq(athletes.phone, '+E164')));
     process.exit(0);
   "
   ```
3. Run the export:
   ```bash
   railway run -- bun run src/scripts/admin-export-athlete.ts <uuid> --out /tmp/marp-export-<uuid>.json
   ```
4. Send the JSON to the runner via their preferred channel.
5. (Optional, recommended) Log this in a manual audit record for compliance documentation.

### Article 17 request received (not via chat)

If a runner asks via email or another channel:

1. Verify authenticity (same as Article 15)
2. Run the admin CLI:
   ```bash
   railway run -- bun run src/scripts/admin-delete-athlete.ts <uuid>
   ```
3. Confirm with the runner that the deletion is complete.

If via chat (much more common): no operator action needed — the chat command handles it.

### Dormancy decline / consent decline

These two paths archive (don't delete) the athlete row. The phone is freed for re-onboarding via the partial unique index. The row itself stays so we have audit evidence of "this person consented at time X, then declined at time Y, then a new person consented at time Z on the same phone."

If a runner who archived via dormancy later wants their data deleted entirely (not just archived), use the admin CLI.

---

## Test coverage

Privacy-related test files (run against the Railway proxy DB with `ALLOW_DESTRUCTIVE_DB=1`):

- `src/services/consent.test.ts` — 42 tests on the notice copy + intent classifier + persistence
- `src/services/erasure.test.ts` — cascade verification across every linked table + idempotent re-delete
- `src/services/erasure-intent.test.ts` — chat-pattern detection + confirmation phrase rules
- `src/services/phone-redact.test.ts` — redaction format + edge cases (whatsapp: prefix, short strings, null)
- `src/db/test-guard.ts` — prevents test TRUNCATEs from running against the Railway proxy URL (override via `ALLOW_DESTRUCTIVE_DB=1` for explicit ops)

---

## Related docs

- `docs/architecture.md` — where in the flow consent / erasure / etc. fire
- `docs/memory-model.md` — what's in the DB
- `docs/reference/admin-scripts.md` — all admin CLIs
- `src/services/consent.ts` — privacy notice copy (source of truth)
