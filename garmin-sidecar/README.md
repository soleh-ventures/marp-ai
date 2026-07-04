# garmin-sidecar

Personal Garmin recovery ingester for MARP. Pulls **your own** Garmin FR245
recovery signals (sleep, stress, body battery, resting HR, respiration) and —
in a later step — writes a daily `daily_wellness` row into MARP's Postgres and
computes a readiness score that stands in for the HRV Status the FR245 can't
provide.

**Personal use only.** This uses the unofficial `python-garminconnect` client
with your own login. Do NOT collect anyone else's Garmin data this way — that
needs a business entity + Garmin's official Health API + GDPR compliance. See
`~/.gstack/projects/soleh-ventures-marp-ai/2026-07-04-design-garmin-recovery-ingester.md`.

Decoupled from the Bun app on purpose: it's Python, runs on its own schedule
(local cron now, Railway cron service later), and shares only the Postgres.

## Setup

```bash
cd garmin-sidecar
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # fill GARMIN_EMAIL / GARMIN_PASSWORD
```

## Step 1 — probe (do this first)

Confirms which fields your FR245 actually returns before we build the schema.
Writes nothing to any database.

```bash
python probe.py               # yesterday
python probe.py 2026-07-03    # a specific day
```

First run prompts for your MFA code if 2FA is on; after that the token in
`tokens/` is reused and the password isn't needed. `tokens/`, `.env`, and
`out/` are gitignored (they hold secrets / personal health data).

Paste the printed summary back and we lock the `daily_wellness` schema and the
readiness scoring to your real fields.

## Step 2 — ingest + readiness (built)

```bash
export DATABASE_URL=postgres://USER@localhost:5432/marp_ai_dev
python ingest.py                       # backfill from last stored day to yesterday
python ingest.py 2026-07-01            # one day
python ingest.py 2026-06-14 2026-07-03 # explicit range
```

`ingest.py` pulls the working FR245 endpoints, upserts into `garmin_wellness`
(keep-non-null merge, so a later partial pull never clobbers good values),
re-pulls the trailing few days to catch late sleep data, and recomputes
`readiness` from the merged row. Catch-up safe (backfills missed days) and
idempotent (safe to re-run).

`readiness.py` — the derived HRV proxy: percentile rank of resting HR (inverted),
morning body battery, and sleep quality vs your own trailing baseline. Needs
14 days before it scores; band = green/amber/red by tertile. Computed once at
ingest and stored; the TS coach reads the stored value.

## Tests

```bash
DATABASE_URL=postgres://USER@localhost:5432/marp_ai_dev python -m pytest -q
```

Readiness unit tests run without a DB; the schema-contract + partial-merge tests
need `DATABASE_URL` (they roll back, nothing persists) and skip without it.

## Modules
- `garmin_client.py` — login (token cache + MFA), the display-name fix, 429 retry, per-day normalization
- `ingest.py` — backfill + merge upsert + rescore
- `readiness.py` — percentile-of-3 score
- `probe.py` — one-day field dump (diagnostics)

## Roadmap (next)
- TS analytics: acute:chronic workload ratio + monotony from `activities`
- Wire `readiness` into the M1 coaching brain (adapt session by band)
- Railway cron service running `ingest.py` each morning against prod
