# Admin scripts — reference

Four operator-facing CLIs ship with v1. All run locally (`bun run …`) or against prod via `railway run -- bun run …`.

| Script | Use when | Destructive? |
|---|---|---|
| `admin:export-athlete` | A runner requests their data (GDPR Article 15) | No (read-only) |
| `admin:delete-athlete` | A runner requests deletion via email (GDPR Article 17) | YES — permanent |
| `admin:summarize-block` | Force-summarise a race block out-of-cycle | No (idempotent) |
| `strava:bootstrap` | After every Railway deploy that changes `TWILIO_PUBLIC_WEBHOOK_BASE` | Mostly no (idempotent reconcile) |

---

## `admin:export-athlete`

GDPR Article 15 export.

```bash
bun run admin:export-athlete <athlete-uuid>
bun run admin:export-athlete <athlete-uuid> --out path.json
```

### Arguments

| Arg | Type | Required | Effect |
|---|---|---|---|
| `<athlete-uuid>` | UUID | yes | Athlete to export. Errors if not found. |
| `--out path.json` | file path | no | Write JSON to file instead of stdout. Logs to stderr that the file was written. |

### Output shape

JSON object with these top-level fields:

```
exportedAt            ISO timestamp
gdprArticle           "Article 15 — right of access"
athlete               { id, phone, name, locale, athletic_history, last_seen_at,
                        archived_at, consent_granted_at, created_at }
messages              [{ direction, body, mediaUrl, receivedAt,
                          resolvesPendingDecisionId }, ...]
activities            [{ ...full activities row including raw_payload }]
activeFlags           [{ kind, body, started_at, resolved_at }, ...]
raceBlocks            [{ ...including summary }]
pendingDecisions      [{ frame, resolved_at, resolved_key }, ...]
stravaConnections     [{ id, strava_athlete_id, scope, connected_at,
                          last_refreshed_at, revoked_at, token_expires_at,
                          encrypted_access_token: "<redacted>",
                          encrypted_refresh_token: "<redacted>" }]
```

Strava encrypted tokens are deliberately replaced with `"<redacted>"`. The runner is requesting *their* data; the symmetric ciphertext that protects access doesn't belong to them.

### Error codes

- `1` — invalid UUID format or athlete not found
- `1` — DB connection failure (writes the error to stderr)

### Examples

Stdout to file:
```bash
bun run admin:export-athlete bf7e0f84-c464-4973-9bd6-3c36f2b8e273 > export.json
```

Direct file write:
```bash
bun run admin:export-athlete bf7e0f84-c464-4973-9bd6-3c36f2b8e273 --out export.json
```

Against prod:
```bash
railway run -- bun run src/scripts/admin-export-athlete.ts bf7e0f84-c464-4973-9bd6-3c36f2b8e273 --out /tmp/marp-export.json
```

---

## `admin:delete-athlete`

GDPR Article 17 erasure via admin CLI.

```bash
bun run admin:delete-athlete <athlete-uuid>           # interactive confirm
bun run admin:delete-athlete <athlete-uuid> --yes     # skip prompt (scripts)
```

### Arguments

| Arg | Type | Required | Effect |
|---|---|---|---|
| `<athlete-uuid>` | UUID | yes | Athlete to delete |
| `--yes` | flag | no | Skip the interactive YES confirmation |

### Behaviour

1. Reads athlete + counts of every linked table
2. Prints a summary with the phone REDACTED (via `redactPhone`) so terminal scrollback doesn't leak
3. Prompts for `YES` (unless `--yes`)
4. Calls `deleteAthlete()` — single DELETE on athletes row, FK cascades handle the rest

### Cascade effect (reference)

| Table | onDelete | Result |
|---|---|---|
| `race_blocks` | CASCADE | rows deleted |
| `activities` | CASCADE | rows deleted |
| `active_flags` | CASCADE | rows deleted |
| `messages` | CASCADE | rows deleted |
| `strava_connections` | CASCADE | rows deleted |
| `pending_decisions` | CASCADE | rows deleted |
| `llm_calls` | SET NULL on athlete_id + message_id; `input_user`/`output_text` scrubbed to NULL | rows survive anonymised — cost telemetry preserved, PII prompt/reply text removed |
| `processed_messages` | (no FK) | not affected; Twilio SIDs survive |

### Examples

Interactive:
```bash
bun run admin:delete-athlete bf7e0f84-c464-4973-9bd6-3c36f2b8e273
# > About to delete:
# >   athlete id:       bf7e0f84-...
# >   phone:            +***4567
# >   name:             Sarah
# >   created:          2026-04-01T...
# >   messages:         247
# >   activities:       42
# >   ...
# > Type YES to permanently delete: YES
# > Done.
```

Scripted (do not use without verifying the UUID first):
```bash
bun run admin:delete-athlete bf7e0f84-c464-4973-9bd6-3c36f2b8e273 --yes
```

---

## `admin:summarize-block`

Force-trigger T8 narrative summarisation on a race block (out of the normal auto-transition flow).

```bash
bun run admin:summarize-block <block-uuid>
```

### Arguments

| Arg | Type | Required | Effect |
|---|---|---|---|
| `<block-uuid>` | UUID | yes | Race block to summarise |

### Behaviour

- Calls `summarizeBlock(blockId)` from `src/memory/summarize.ts`
- Idempotent: if `race_blocks.summary` is already populated, returns `written: false` (no LLM call)
- On fresh summarisation: pulls 18-week-pre + 1-week-post window of activities + flags + messages, calls Sonnet, persists summary + flips `state` to `completed` in one transaction
- Cost: ~$0.005 per block (Sonnet, ~500 input + ~300 output tokens after caching)

### When to use

- A runner switched goals mid-cycle and you want to close the old block
- A test deploy where auto-transition didn't fire
- Backfill summaries for blocks that completed before T8 shipped

### Example

```bash
railway run -- bun run src/scripts/admin-summarize-block.ts 87a3f001-2b5c-4912-9876-d4cb01e2a345
# Summarizing race_block 87a3f001-...
#   written: true
#   summary length: 1248
```

---

## `strava:bootstrap`

Idempotent reconcile of the Strava webhook subscription.

```bash
bun run strava:bootstrap
```

### When to run

- Once on initial deploy (after Railway is live + env vars set)
- After every deploy where `TWILIO_PUBLIC_WEBHOOK_BASE` changes (new Railway env, switching ngrok tunnels in dev, custom domain switch)
- After re-creating the Strava subscription manually for any reason

### Required env vars

| Var | Source |
|---|---|
| `STRAVA_CLIENT_ID` | Strava app dashboard |
| `STRAVA_CLIENT_SECRET` | Strava app dashboard |
| `STRAVA_WEBHOOK_VERIFY_TOKEN` | self-generated (any random string) |
| `TWILIO_PUBLIC_WEBHOOK_BASE` | Railway public domain |

Bootstrap fails fast with a clear message if any are missing.

### Outcome

Three actions are possible:

| Action | Cause |
|---|---|
| `noop` | Strava already has exactly one subscription pointing at our callback URL |
| `created` | No prior subscription — fresh registration |
| `replaced` | Stale subscription found (callback URL drifted, or multiple rows) — torn down + recreated |

The new subscription ID is written to `strava_webhook_config.subscription_id` (or confirmed if unchanged) and serves as the origin guard for incoming webhook events.

### Example

```bash
railway run -- bun run src/scripts/bootstrap-strava-webhook.ts
# Reconciling Strava webhook subscription…
#   action: created
#   callback_url: https://marp-ai-production.up.railway.app/webhooks/strava
#   subscription_id: 273456
```

### Failure modes

- **Server not reachable from public internet** — Strava performs a live `hub.challenge` handshake during `create`. If our server isn't live, the create call returns 400. Fix: ensure Railway is deployed + healthy before running bootstrap.
- **`verify_token` mismatch** — Strava's handshake expects the token we passed to match what our handler returns. If `STRAVA_WEBHOOK_VERIFY_TOKEN` differs between bootstrap and the running server (e.g., env not updated since), bootstrap fails. Fix: align env vars across Railway dashboard + the bootstrap shell.

---

## Common patterns

### Reading an athlete UUID from a phone number

There's no first-class CLI for this. One-off bash:

```bash
railway run -- bun -e "
  const { db } = await import('./src/db/client.ts');
  const { athletes } = await import('./src/db/schema.ts');
  const { eq } = await import('drizzle-orm');
  console.log(
    await db
      .select({ id: athletes.id, name: athletes.name, createdAt: athletes.createdAt })
      .from(athletes)
      .where(eq(athletes.phone, '+15551234567'))
  );
  process.exit(0);
"
```

### Counting open vs resolved pending decisions

```bash
railway run -- bun -e "
  const { db } = await import('./src/db/client.ts');
  const { sql } = await import('drizzle-orm');
  console.log(await db.execute(sql\`
    SELECT
      count(*) FILTER (WHERE resolved_at IS NULL) AS open,
      count(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved
    FROM pending_decisions
  \`));
  process.exit(0);
"
```

### Inspecting cache hit rate

```bash
railway run -- bun -e "
  const { db } = await import('./src/db/client.ts');
  const { sql } = await import('drizzle-orm');
  console.log(await db.execute(sql\`
    SELECT
      component,
      count(*) AS calls,
      count(*) FILTER (WHERE cache_hit) * 100.0 / count(*) AS cache_hit_pct,
      avg(latency_ms) AS avg_latency_ms,
      sum(cost_estimate_usd) AS total_cost
    FROM llm_calls
    WHERE created_at > now() - interval '7 days'
    GROUP BY component
    ORDER BY total_cost DESC
  \`));
  process.exit(0);
"
```

A real observability dashboard (T15) is in `TODO.md`.

---

## Related docs

- `docs/privacy.md` — GDPR workflows that use these CLIs
- `docs/strava-integration.md` — Strava bootstrap as part of deploy
- `docs/howto/deploy-to-railway.md` — when to run each script
