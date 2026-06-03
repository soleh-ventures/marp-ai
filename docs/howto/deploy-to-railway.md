# How to deploy MARP to Railway

End-to-end deploy of a fresh MARP instance from scratch. Assumes you have a GitHub account, a Twilio account (with WhatsApp sandbox or production sender), a Strava developer app, and an Anthropic API key.

Takes about 30 minutes the first time.

---

## Prerequisites

- A Railway account (railway.app)
- The MARP repo forked or cloned in your GitHub
- Twilio account SID + auth token + a WhatsApp-enabled sender ("From" number, formatted `whatsapp:+E164`)
- Strava developer app — create at `strava.com/settings/api`. Note the Client ID and Client Secret.
- Anthropic API key

You'll need a terminal with `bun` installed (`curl -fsSL https://bun.sh/install | bash`) and the Railway CLI (`brew install railway` on macOS, or follow the Railway docs for other platforms).

---

## Step 1: Create the Railway project

In the Railway dashboard:

1. **New Project → Deploy from GitHub repo** → select your MARP fork
2. Railway auto-detects the `nixpacks.toml` + `railway.toml` and starts a build
3. **+ New → Database → PostgreSQL** — provisions a managed Postgres
4. Railway automatically injects `DATABASE_URL` into the app service

Wait for the first build to land. It'll fail health-check until you set the env vars in Step 2, but that's expected.

---

## Step 2: Set env vars

Open the app service → Variables. Add all of these (the database URL is already injected):

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=<your twilio auth token>
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886    # Twilio sandbox, or your prod sender
TWILIO_PUBLIC_WEBHOOK_BASE=https://<your-railway-domain>

STRAVA_CLIENT_ID=12345
STRAVA_CLIENT_SECRET=<your strava client secret>
STRAVA_WEBHOOK_VERIFY_TOKEN=<random hex, see below>
STRAVA_TOKEN_ENCRYPTION_KEY=<64-char hex, see below>

MAGIC_LINK_SECRET=<64-char hex, see below>

ANTHROPIC_API_KEY=sk-ant-api03-...
```

Generate the three secrets locally:

```bash
openssl rand -hex 16    # STRAVA_WEBHOOK_VERIFY_TOKEN
openssl rand -hex 32    # STRAVA_TOKEN_ENCRYPTION_KEY (must be 64 hex chars)
openssl rand -hex 32    # MAGIC_LINK_SECRET (must be 64 hex chars)
```

Save them in a password manager. They're never recoverable — losing `STRAVA_TOKEN_ENCRYPTION_KEY` means every connected runner needs to reconnect.

After all vars are set, Railway redeploys automatically.

---

## Step 3: Generate the Railway public domain

Open the app service → Settings → Networking → **Generate Domain**. Copy the resulting `https://<...>.up.railway.app`. Paste it back into the `TWILIO_PUBLIC_WEBHOOK_BASE` env var (it must match).

The redeploy after editing `TWILIO_PUBLIC_WEBHOOK_BASE` is required — Strava's OAuth callback URL is built from this var.

---

## Step 4: Run the database migrations

Migrations don't auto-run on deploy. From your local terminal:

```bash
railway link                                              # pick the project + service
railway run -- bun run db:migrate
```

Expected output: `applying 0000_*`, `applying 0001_*`, … through the latest migration, then `migrations applied`.

If the migration command fails with `ECONNREFUSED`, your `railway run` is injecting Railway's internal `DATABASE_URL` (which uses `postgres.railway.internal:5432`) but your laptop can't reach the internal hostname. Use the public proxy URL instead:

```bash
railway variables --service Postgres | grep DATABASE_PUBLIC_URL
# Copy the postgresql://...zephyr.proxy.rlwy.net:... URL it prints

DATABASE_URL="<that public url>" bun run src/db/migrate.ts
```

---

## Step 5: Configure Strava OAuth callback domain

In `strava.com/settings/api` for your app:

- **Authorization Callback Domain**: set to the hostname of your Railway domain (no `https://`, no path). Example: `marp-ai-production.up.railway.app`.

Strava verifies callback URLs against this domain. A mismatch produces a "redirect_uri mismatch" error during OAuth.

---

## Step 6: Bootstrap the Strava webhook subscription

```bash
railway run -- bun run src/scripts/bootstrap-strava-webhook.ts
```

Expected:

```
Reconciling Strava webhook subscription…
  action: created
  callback_url: https://<your-railway-domain>/webhooks/strava
  subscription_id: <number>
```

If you get `action: noop`, a previous bootstrap left a valid subscription in place. If you get `replaced`, an earlier callback URL was stale — also fine.

**Common failure**: `Strava create subscription 400`. Usually means our server isn't reachable from the public internet during Strava's synchronous `hub.challenge` handshake. Check:

- Is Railway showing the deploy as **Active**?
- Does `curl https://<your-railway-domain>/health` return `{"ok":true,"db":"ok"}`?
- Are `STRAVA_CLIENT_ID` + `STRAVA_CLIENT_SECRET` correct?
- Does `STRAVA_WEBHOOK_VERIFY_TOKEN` match what the running server expects (i.e., the latest deploy picked up the env var)?

---

## Step 7: Wire up Twilio webhook

In the Twilio console:

- **Messaging → Try it out → Send a WhatsApp message** (if you're on the sandbox), or
- **Messaging → Senders → WhatsApp senders** (if you have a production sender)

Find the **When a message comes in** field. Set:

- URL: `https://<your-railway-domain>/webhooks/twilio/whatsapp`
- Method: `POST`

Save. The path is `/webhooks/twilio/whatsapp` — note the trailing `/whatsapp`, that's the route mounted in `src/server.ts`.

---

## Step 8: Verify

Open the Railway logs viewer for your service. Send "hi" to your MARP number from your phone.

Within ~3 seconds you should see:

```
POST /webhooks/twilio/whatsapp 200
```

Followed by your phone receiving the **privacy notice** (the first reply on any fresh athlete).

Reply "YES" — onboarding begins. Reply with your name + goal race.

If you don't see the POST in Railway logs:

- Twilio webhook URL probably points at the wrong host. Double-check Step 7.
- Or the Twilio signature is failing. Check `TWILIO_AUTH_TOKEN` in Railway matches your Twilio account.

---

## Step 9: First Strava connect (smoke test)

Send "connect strava" to MARP. You should receive a magic link. Tap it on your phone.

The flow:

1. Magic link verifies via HMAC
2. Redirect to Strava consent screen
3. Approve → Strava posts back to `/auth/strava/callback`
4. Token exchange + encryption + persistence
5. Backfill kicks off (up to 60 days of activities)
6. MARP confirms via WhatsApp: "✅ Strava connected! I pulled in your last N activities…"

If the callback fails with "Something went wrong":

- Check Railway logs for `strava callback: token exchange / upsert failed`. Common causes:
  - `STRAVA_CLIENT_SECRET` mismatch
  - `STRAVA_TOKEN_ENCRYPTION_KEY` not exactly 64 hex chars
  - `TWILIO_PUBLIC_WEBHOOK_BASE` doesn't match the Strava-registered callback domain

---

## What's running now

After this guide:

- MARP listens on `/webhooks/twilio/whatsapp` for inbound WhatsApp
- MARP listens on `/webhooks/strava` for Strava activity events
- `/auth/strava/start` + `/auth/strava/callback` handle the OAuth flow
- `/health` returns DB connectivity status

The architecture diagram lives in `docs/architecture.md`.

---

## Re-deploying

Subsequent deploys: just `git push` to your fork's main branch. Railway auto-deploys.

After a deploy that:

- Changes `TWILIO_PUBLIC_WEBHOOK_BASE` → re-run `strava:bootstrap`
- Adds a new migration → run `bun run db:migrate` (or `railway run -- bun run db:migrate`)
- Changes prompts in `prompts/` → no extra step; they're read at request time (with an in-process cache)

---

## Costs to watch

- **Railway**: ~$5–10/month for a single-replica app + Postgres at v1 scale
- **Anthropic API**: depends on volume. Per-runner per-week median is ~$0.10 with prompt caching active
- **Twilio WhatsApp**: ~$0.005 per outbound message (production sender pricing varies by country)
- **Strava API**: free, with rate limits we're nowhere near at v1 scale

Watch the cost per LLM component:

```bash
railway run -- bun -e "
  const { db } = await import('./src/db/client.ts');
  const { sql } = await import('drizzle-orm');
  console.log(await db.execute(sql\`
    SELECT
      component,
      sum(cost_estimate_usd) AS cost_7d,
      count(*) AS calls_7d,
      count(*) FILTER (WHERE cache_hit) * 100.0 / count(*) AS cache_hit_pct
    FROM llm_calls
    WHERE created_at > now() - interval '7 days'
    GROUP BY component
    ORDER BY cost_7d DESC
  \`));
  process.exit(0);
"
```

---

## Related docs

- `docs/strava-integration.md` — Strava OAuth + webhook details
- `docs/reference/admin-scripts.md` — `strava:bootstrap`, admin CLIs
- `docs/privacy.md` — GDPR posture (consent + erasure + export)
- `docs/architecture.md` — end-to-end request flow
