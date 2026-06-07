# marp-ai

A personal AI running companion — coach, mental, nutrition, injury, recovery, gear — that learns the runner's story and walks beside them to their goals, mindfully and happily. Delivered over WhatsApp via Twilio; grounded in real training data via Strava + GPX uploads.

## Documentation

**Product**
- [`docs/prd-v1.md`](docs/prd-v1.md) — what v1 is, what's in scope, success metrics
- [`docs/gtm/positioning.md`](docs/gtm/positioning.md) — how we talk about MARP
- [`docs/gtm/features.md`](docs/gtm/features.md) — runner-facing feature list
- [`docs/gtm/faq.md`](docs/gtm/faq.md) — common questions

**Engineering**
- [`docs/architecture.md`](docs/architecture.md) — end-to-end request flow
- [`docs/memory-model.md`](docs/memory-model.md) — what MARP remembers and how
- [`docs/strava-integration.md`](docs/strava-integration.md) — OAuth + webhook + ingest
- [`docs/privacy.md`](docs/privacy.md) — GDPR posture and admin workflows
- [`docs/reference/admin-scripts.md`](docs/reference/admin-scripts.md) — operator CLIs
- [`docs/howto/deploy-to-railway.md`](docs/howto/deploy-to-railway.md) — first-time deploy

**Backlog**
- [`TODO.md`](TODO.md) — post-v1 features, prioritised by UX impact

## Stack

- Bun + TypeScript
- Hono (HTTP)
- Drizzle ORM + Postgres
- Railway (hosting + managed Postgres)

## Local setup

```bash
bun install
cp .env.example .env          # then edit DATABASE_URL
createdb marp_ai_dev          # or point at any Postgres
bun run dev
curl http://localhost:3000/health
```

`/health` returns 200 when the DB is reachable, 503 otherwise.

## Scripts

| Command              | What it does                                    |
| -------------------- | ----------------------------------------------- |
| `bun run dev`        | Hot-reloading dev server                        |
| `bun run start`      | Production server                               |
| `bun run typecheck`  | `tsc --noEmit`                                  |
| `bun run db:generate`| Generate a migration from `src/db/schema.ts`    |
| `bun run db:migrate` | Apply pending migrations                        |
| `bun run db:studio`  | Open Drizzle Studio                             |

## Deploy

Railway picks up `nixpacks.toml` for the build and `railway.toml` for the start/health config. Attach the Postgres plugin to inject `DATABASE_URL`.

## Layout

```
src/
  webhooks/     Twilio + Strava webhook handlers
  routes/      Strava OAuth start + callback
  services/    Business logic — process-incoming orchestrator, consent,
              safety (triage + deterministic floor, run first on every
              message), binder, flag-detector, erasure, dormancy, Strava
              (OAuth, tokens, activities, backfill, subscriptions), ingest
  router/      Classifier + domain runner + synthesizer + decision-frame
  memory/      getMemoryContext + block summarization
  ingest/      File upload (GPX) parser
  flows/       Onboarding state machine
  middleware/  Rate limiter
  db/          Schema + client + test guard
  scripts/     Admin CLIs (delete, summarize, export athlete; Strava bootstrap)
prompts/       LLM persona prompts (classifier, 6 domains, synthesizer,
              binder, flag-detector, summarizer, onboarding)
drizzle/       Generated SQL migrations
docs/          Product + engineering documentation (see top of file)
```

See [`docs/architecture.md`](docs/architecture.md) for the full diagram and module-boundary explanation.
