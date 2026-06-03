# Strava integration

The full data path from a runner connecting their Strava account to MARP rendering their training in memory context.

---

## Why Strava

Strava is the dominant social platform for runners, with deep integrations into Garmin, Apple, Wahoo, Polar, Coros, and basically every other device. Hooking into Strava once gets us coverage of ~90% of runners who track digitally.

Two flows we care about:

1. **OAuth + backfill** — a one-time connection that grants ongoing read access + immediately pulls the last 60 days of history
2. **Webhook subscription** — push-based notification when the runner uploads a new activity (or edits one)

The token refresh, encryption, and webhook origin-guard layers exist to make both of those work safely.

---

## OAuth flow

Strava uses standard OAuth 2.0 authorisation code. Our wrinkle: WhatsApp users don't have a browser context, so we send a **magic link** that bridges chat → web → Strava → callback.

### Step-by-step

1. **Runner says "connect strava"** (or "link strava" / "sync strava" / etc.)
2. `looksLikeStravaConnect()` matches; `getStravaConnectStatus()` checks current state
3. If not yet connected: `buildMagicLink()` signs an HMAC-SHA256 token over `{athleteId, expiry, nonce}` and embeds it in `https://<host>/auth/strava/start?token=<...>`
4. MARP sends the magic-link URL via WhatsApp
5. Runner taps the link on their phone
6. `/auth/strava/start` verifies the magic-link token (HMAC + expiry check, constant-time compare), then redirects to Strava's consent screen with `redirect_uri=/auth/strava/callback`, `state=<athleteId>`
7. Runner approves on Strava (or denies — `error=access_denied` path renders a friendly close)
8. Strava redirects to `/auth/strava/callback?code=<code>&state=<athleteId>`
9. Handler calls Strava's token exchange endpoint with the code + our client secret → receives `{access_token, refresh_token, expires_at, athlete: {id, ...}, scope}`
10. `upsertStravaConnection()` encrypts both tokens (AES-256-GCM, fresh IV per encryption) and writes to `strava_connections`
11. **Fire-and-forget backfill** kicks off — `backfillStravaHistory()` pulls the last 60 days
12. Once backfill completes, MARP sends a WhatsApp confirmation with the activity count: "✅ Strava connected! I pulled in your last 47 activities (up to 60 days) — caught up on your recent training."

### Why 60 days for backfill

Sports science consensus:

- TrainingPeaks Chronic Training Load uses a 42-day exponentially-weighted window
- Acute:chronic workload ratio uses 28 days as the chronic baseline
- 30 days falls below both standards
- 60 days clears them with margin

For a beginner (2 runs/wk), 30 days gives 8 data points — too thin to distinguish consistency from chance. 60 days gives 16 — enough for the LLM (and the future planner) to detect patterns.

Cost: 1–2 API calls via Strava's summary endpoint (returns 200 activities per page). Strava's API is free; this is bounded.

### Why a magic link, not direct OAuth from WhatsApp

There's no way to "deep link" from WhatsApp directly into a Strava OAuth flow without an intermediate web step. The magic link is that step. Benefits:

- The athlete UUID is bound to the link (via `state` param). No way to authorize Strava for the wrong athlete.
- The 5-minute TTL on the magic link means a leaked link goes stale quickly.
- HMAC signing prevents URL tampering.

Known v1 gap: an attacker who guesses an athlete UUID could complete the Strava flow with their own code + `state=<victim_uuid>`. Proper fix is PKCE / server-side flow state. UUID guessing within the 5-min TTL is narrow; deferred to v1.1.

### Token lifecycle

- **Access token**: ~6 hour TTL, refreshed on demand
- **Refresh token**: long-lived, used to mint new access tokens
- **Refresh path**: `getFreshAccessToken(conn)` checks expiry; if within 1 hour, calls Strava's `/oauth/token` with `grant_type=refresh_token`; persists the new pair via `updateRefreshedTokens()`
- **Revocation**: if Strava returns 401 on refresh, `markRevoked()` sets `revoked_at` and the next memory context tells the LLM "Strava was disconnected — the runner needs to reconnect"

A separate cron-style refresh job (ET13 in the original eng-review) is not implemented in v1. Refreshes happen on-demand when ingestion needs a token. For runners who don't trigger any activity ingest for >6 hours, tokens go stale silently — but the next webhook event triggers a refresh.

---

## Webhook subscription

### Bootstrap

Strava webhooks are **app-level, not per-user**. We register exactly one subscription that points at our public webhook URL; Strava sends events for every authorised athlete through it.

```bash
bun run strava:bootstrap                  # local
railway run -- bun run strava:bootstrap   # prod
```

`reconcileStravaSubscription()` (in `src/services/strava-subscriptions.ts`) is idempotent:

- If a subscription already exists pointing at our callback URL → `noop`
- If a stale subscription exists for a different URL → tear down + create new (`replaced`)
- If no subscription exists → create (`created`)

The handshake during `create` is synchronous: Strava POSTs `hub.challenge` to our callback URL with the `verify_token` we provided. If the server isn't reachable from the public internet, the create call returns 400. So bootstrap MUST run after Railway is live.

The subscription ID Strava returns is saved to `strava_webhook_config.subscription_id` and used as the origin guard.

### Event shape

```json
{
  "object_type": "activity" | "athlete",
  "object_id": 12345678,
  "aspect_type": "create" | "update" | "delete",
  "owner_id": 98765432,
  "subscription_id": 1234,
  "event_time": 1696425600,
  "updates": { ... }
}
```

### Subscription-ID origin guard

Strava doesn't sign webhook POSTs (no HMAC mechanism in their API). The only origin check we can make is matching `event.subscription_id` against our stored one.

```typescript
async function isExpectedSubscription(eventSubId: number): Promise<boolean> {
  if (cachedSubscriptionId !== null) return eventSubId === cachedSubscriptionId;
  const record = await getActiveSubscriptionRecord();
  if (!record) return false;
  cachedSubscriptionId = record.subscriptionId;
  return eventSubId === cachedSubscriptionId;
}
```

Mismatched events: ack 200 (so Strava doesn't retry forever) but log + skip processing. An attacker who learns our webhook URL would have to also know our numeric subscription_id to slip events past this check.

Cache is process-local; resets on deploy. Re-running `strava:bootstrap` invalidates the cache on next request (the saved subscription_id changes).

### Activity ingest

Two aspect types trigger ingest: `create` and `update`. Strava's docs say manual entries fire `create`, but in practice we've observed manual entries arriving as `update` instead. Ingesting both lets us catch manual runs that would otherwise be lost.

`ingestStravaActivity(stravaAthleteId, activityId)`:

1. `findByStravaAthleteId()` → look up our `strava_connections` row. Unknown owner_id → silent no-op.
2. `getFreshAccessToken()` → refresh if needed
3. Call Strava's `GET /api/v3/activities/{id}` (full detail endpoint, includes splits + extensions)
4. `normalizeStravaActivity()` → map sport_type → MARP discipline, build metrics jsonb, flag long_run
5. `INSERT … ON CONFLICT DO NOTHING` against `(source, source_id)` unique index → idempotent on retries

### Deauthorisation

Strava sends `object_type=athlete, aspect_type=update, updates={authorized: "false"}` when a runner removes MARP's access from Strava's side. The handler calls `markRevoked()` on the connection. The next memory context tells the LLM Strava was disconnected.

---

## Discipline mapping

MARP's domain prompts speak in a small vocabulary: `run`, `ride`, `swim`, `walk`, `hike`, `strength`, `mobility`, `cross`, `other`. Strava's `sport_type` is much richer (Run, TrailRun, VirtualRun, Ride, GravelRide, MountainBikeRide, etc.).

`src/services/strava-activities.ts` maps:

```
Run, TrailRun, VirtualRun        → "run"
Ride, VirtualRide, GravelRide,
  MountainBikeRide               → "ride"
Swim                             → "swim"
Walk                             → "walk"
Hike                             → "hike"
WeightTraining, Workout          → "strength"
Yoga                             → "mobility"
Elliptical, StairStepper         → "cross"
(everything else)                → "other"
```

Same mapping is used by the GPX parser (`src/ingest/gpx.ts`) so a `<type>Running</type>` GPX export and a Strava Run event produce identical discipline values.

---

## Token encryption details

`src/services/token-cipher.ts`:

```typescript
// encrypt(plaintext): base64(iv || ciphertext || auth_tag)
const iv = crypto.randomBytes(12);              // 96-bit, GCM standard
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
const authTag = cipher.getAuthTag();
return Buffer.concat([iv, ciphertext, authTag]).toString('base64');
```

Key requirements (enforced at startup):

- Exactly 32 bytes after hex-decoding `STRAVA_TOKEN_ENCRYPTION_KEY` (i.e., 64 hex chars)
- Loaded at module init; missing/wrong-length throws

A fresh IV per encryption is critical for GCM mode — reusing an IV with the same key destroys confidentiality and authenticity. We pull from `crypto.randomBytes()` each call.

The auth tag is verified on decrypt; tampered ciphertext throws.

---

## Failure modes and recovery

| Failure | Symptom | Recovery |
|---|---|---|
| Strava client_secret rotated | Token exchange 401 on next connect | Update env, redeploy |
| Token encryption key lost/changed | Existing tokens can't decrypt → all runners need to reconnect | Force re-onboarding via `markRevoked()` on all connections; chat acknowledges via memory context |
| Webhook subscription invalidated | New activities stop ingesting | Re-run `strava:bootstrap`; existing tokens still work for refresh |
| Backfill fails partway | Some activities missing | Idempotent — re-run; ON CONFLICT skips already-ingested |
| Strava API rate limit | 429 responses | No exponential backoff in v1; defer to ET12 |

---

## What we deliberately don't store

- Strava athlete profile (gender, weight, country, etc.) — we only need the activity stream
- Heart rate streams, GPS traces, lap splits — only summary metrics
- Strava social data (kudos, comments, followers) — out of scope

Our `activities.raw_payload` jsonb does store the full Strava response for backfill / future re-parsing, but we don't promise to mine those fields beyond the metrics we already extract.

---

## Related docs

- `docs/architecture.md` — where Strava sits in the request flow
- `docs/memory-model.md` — how Strava status surfaces in the LLM context
- `docs/howto/deploy-to-railway.md` — bootstrap as part of deploy
- `src/routes/strava-auth.ts` — OAuth start + callback
- `src/webhooks/strava.ts` — webhook handler
- `src/services/strava-*.ts` — all the Strava services
