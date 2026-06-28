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
# requires DATABASE_URL (Postgres); default PORT=3001
DATABASE_URL=postgres://user:pass@host:5432/db bun run server/main.ts

# run migrations only
DATABASE_URL=postgres://user:pass@host:5432/db bun run server/migrate.ts
```

## Env vars

| Name                | Default  | Purpose                                |
| ------------------- | -------- | -------------------------------------- |
| `PORT`              | `3001`   | Listen port                            |
| `STATIC_DIR`        | `./dist` | SPA asset directory                    |
| `DATABASE_URL`      | —        | Required — Postgres connection string  |
| `DATABASE_POOL_MAX` | `10`     | Max postgres pool connections          |
| `GEOIP_DB_PATH`     | —        | Path to GeoLite2-City.mmdb (see below) |

### Geo-IP

The Compute Available view's world map uses MaxMind GeoLite2 to resolve each
node's `publicHost` to a latitude/longitude. It's entirely optional — when
`GEOIP_DB_PATH` is unset or the file can't be opened the map just renders
without markers.

1. Sign up for a free MaxMind account and create a license key.
2. Download the `GeoLite2-City.mmdb` database and extract it somewhere on disk.
3. Set `GEOIP_DB_PATH=/path/to/GeoLite2-City.mmdb` in the server environment.

Lookups are cached in-memory per hostname for one hour.

## Tests

```sh
bun test server/app.test.ts
```
