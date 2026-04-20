# Quip Dashboard

Post-quantum mining telemetry dashboard for the Quip network. Visualises block
production, mining times, compute usage, and active nodes across CPU, GPU, and
QPU miners.

**Stack:** React, Vite, Tailwind CSS v4, Nivo charts, Zustand, Hono, Bun.

## Architecture

```
  ┌──────────────┐     poll /api/v1/telemetry/*     ┌──────────────┐
  │  quip-node   │ ───────────────────────────────▶ │   indexer    │
  │  (REST API)  │                                  │  (long-run)  │
  └──────────────┘                                  └──────┬───────┘
                                                           │ writes
                                                           ▼
                               ┌──────────────────────────────────────┐
                               │  datastore (sqlite | postgres)       │
                               └──────┬────────────────────┬──────────┘
                                      │ reads              │ reads
                                      ▼                    ▼
                         ┌────────────────┐    ┌────────────────────┐
                         │  Hono server   │    │  Netlify function  │
                         │  (docker)      │    │  (production)      │
                         └────────┬───────┘    └────────┬───────────┘
                                  ▼                     ▼
                               ┌──────────────────────────┐
                               │  React dashboard SPA     │
                               └──────────────────────────┘
```

The **indexer** is a long-running process that polls a quip node's v0.1
telemetry REST API and writes blocks + node snapshots to a datastore. The
dashboard SPA reads from that datastore through one HTTP endpoint —
`GET /api/telemetry` — served by either the Hono backend (docker) or a
Netlify function (production).

## Setup paths

There are two supported deployment paths.

### 1. Netlify + Supabase (production)

The SPA ships on Netlify; telemetry lives in Supabase Postgres; the indexer
runs on a separate always-on host (VM, fly.io, Railway, etc.).

**One-time setup**

1. **Supabase project.** Create a project at [supabase.com](https://supabase.com)
   and copy the Postgres connection string (Settings → Database → Connection
   string, "URI" format).
2. **Migrate schema.** From a machine with `DATABASE_URL` set:
   ```sh
   DB_ADAPTER=postgres DATABASE_URL="postgresql://..." bun run migrate
   ```
3. **Netlify env vars.** In the Netlify dashboard set:
   - `DB_ADAPTER` = `postgres`
   - `DATABASE_URL` = the Supabase Postgres URI
4. **Deploy.** `git push` to your Netlify-connected branch. Build command is
   `bun run build`; the Netlify function at
   `netlify/functions/telemetry.ts` delegates all `/api/telemetry*` requests
   to the Hono app, which reads from Supabase.

**Indexer host**

Run the packaged docker image with the server disabled:

```sh
docker run -d --restart=always \
  -e RUN_SERVER=false \
  -e DB_ADAPTER=postgres \
  -e DATABASE_URL="postgresql://..." \
  -e QUIP_NODE_URL=https://qpu-1.nodes.quip.network \
  registry.gitlab.com/<group>/<project>:latest
```

### 2. Self-hosted docker (local / contributor / homelab)

One image runs the indexer, the Hono API, and the SPA. Defaults to SQLite
with a persistent volume.

**Quickstart (SQLite)**

```sh
docker run -p 3001:3001 \
  -v quip-data:/data \
  -e QUIP_NODE_URL=https://qpu-1.nodes.quip.network \
  registry.gitlab.com/<group>/<project>:latest
```

Then open <http://localhost:3001>.

**Postgres mode (docker-compose)**

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: quip
      POSTGRES_USER: quip
      POSTGRES_PASSWORD: quip
    volumes:
      - pgdata:/var/lib/postgresql/data

  dashboard:
    image: registry.gitlab.com/<group>/<project>:latest
    depends_on: [db]
    environment:
      DB_ADAPTER: postgres
      DATABASE_URL: postgresql://quip:quip@db:5432/quip
      QUIP_NODE_URL: https://qpu-1.nodes.quip.network
    ports: ["3001:3001"]

volumes:
  pgdata:
```

## Configuration reference

| Var                   | Default                            | Component  | Notes                                  |
| --------------------- | ---------------------------------- | ---------- | -------------------------------------- |
| `QUIP_NODE_URL`       | `https://qpu-1.nodes.quip.network` | indexer    | base URL, no `/api/v1` suffix          |
| `QUIP_NODE_TOKEN`     | (unset)                            | indexer    | bearer token if node is protected      |
| `POLL_INTERVAL_SEC`   | `8`                                | indexer    | status-poll cadence                    |
| `NODES_REFRESH_SEC`   | `45`                               | indexer    | nodes-poll cadence                     |
| `BACKFILL_FROM_EPOCH` | (unset)                            | indexer    | start epoch; older epochs are skipped  |
| `VERBOSE`             | (unset)                            | indexer    | `1` enables debug logging              |
| `DB_ADAPTER`          | `sqlite`                           | both       | `sqlite` or `postgres`                 |
| `DATABASE_URL`        | (unset)                            | both       | required when `DB_ADAPTER=postgres`    |
| `SQLITE_PATH`         | `/data/telemetry.db`               | both       | sqlite-only                            |
| `PORT`                | `3001`                             | server     | HTTP listen port                       |
| `STATIC_DIR`          | `/app/dist`                        | server     | built SPA dir served as fallback       |
| `RUN_INDEXER`         | `true`                             | entrypoint | set `false` on Netlify Postgres host   |
| `RUN_SERVER`          | `true`                             | entrypoint | set `false` on a separate indexer host |

## Local development

```sh
bun install

# option A: netlify dev — SPA + netlify function
bun run dev

# option B: run server + indexer separately (matches docker shape)
bun run migrate                    # create tables (sqlite by default)
bun run dev:server                 # :3001
bun run dev:indexer                # polls the default node
bun run dev                        # vite at :5173, proxy /api to :3001 if needed
```

## Layout

```
src/                     React SPA
server/                  Hono backend (GET /api/telemetry, /health, SPA fallback)
indexer/                 Long-running poller
api/db/                  DatabaseAdapter (sqlite, postgres)
netlify/functions/       Netlify wrapper over the Hono app
docker/entrypoint.ts     Supervisor that spawns indexer + server
Dockerfile               Multi-stage multi-arch build
.gitlab-ci.yml           Lint + multi-arch buildx publish
```

## Scripts

```sh
bun run typecheck     # tsc --noEmit
bun test              # bun:test across indexer + server
bun run build         # vite build → dist/
bun run format:check  # prettier --check .
```

## License

AGPL-3.0-or-later.
