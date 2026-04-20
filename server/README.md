# server

Hono-based HTTP server for the Quip dashboard. Runs under Bun for docker/dev
and is wrapped by `netlify/functions/telemetry.ts` on Netlify.

## Routes

| Method | Path                           | Description                                |
| ------ | ------------------------------ | ------------------------------------------ |
| GET    | `/api/telemetry`               | All blocks + latest nodes snapshot         |
| GET    | `/api/telemetry/epochs/:epoch` | Blocks for a specific epoch                |
| GET    | `/api/telemetry/index`         | Epoch summary with block counts            |
| GET    | `/api/health`                  | Liveness + indexer cursor + last node sync |
| GET    | `/*` (opt-in)                  | Static SPA from `STATIC_DIR` (docker only) |

## Running

```sh
# defaults: PORT=3001, DB_ADAPTER=sqlite, SQLITE_PATH=./data/telemetry.db
bun run server/main.ts

# postgres
DB_ADAPTER=postgres DATABASE_URL=postgres://user:pass@host:5432/db bun run server/main.ts

# run migrations only
bun run server/migrate.ts
```

## Env vars

| Name           | Default               | Purpose                 |
| -------------- | --------------------- | ----------------------- |
| `PORT`         | `3001`                | Listen port             |
| `STATIC_DIR`   | `./dist`              | SPA asset directory     |
| `DB_ADAPTER`   | `sqlite`              | `sqlite` or `postgres`  |
| `DATABASE_URL` | —                     | Required for `postgres` |
| `SQLITE_PATH`  | `./data/telemetry.db` | Path for `sqlite`       |

## Tests

```sh
bun test server/app.test.ts
```
