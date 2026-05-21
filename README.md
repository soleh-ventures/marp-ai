# marp-ai

WhatsApp coaching brain for marathon runners. See `~/.gstack/projects/soleh-ventures-marp-ai/` for the design + engineering plan.

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
  server.ts        Hono app + /health
  config.ts        env loader
  db/
    client.ts      Drizzle client + ping()
    schema.ts      (filled in by T2)
    migrate.ts     bun run db:migrate
drizzle/           generated SQL migrations
```
