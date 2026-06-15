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
                               │  datastore (postgres)                │
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
   DATABASE_URL="postgresql://..." bun run migrate
   ```
3. **Netlify env vars.** In the Netlify dashboard set:
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
  -e DATABASE_URL="postgresql://..." \
  -e QUIP_VALIDATOR_RPC_URLS=ws://<validator-host>:9944 \
  registry.gitlab.com/<group>/<project>:latest
```

### 2. Self-hosted docker (local / contributor / homelab)

One image runs the indexer, the Hono API, and the SPA. It connects to a
Postgres instance (the dashboard runs only on Postgres).

**Quickstart (docker-compose)**

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
      DATABASE_URL: postgresql://quip:quip@db:5432/quip
      QUIP_VALIDATOR_RPC_URLS: ws://quip-validator:9944
    ports: ["3001:3001"]

volumes:
  pgdata:
```

Then open <http://localhost:3001>. The entrypoint runs `migrate` before starting
the server + indexer.

## Configuration reference

Every environment variable — names, defaults, components, and what they do — is
documented in [`.env.example`](.env.example), the single source of truth. Copy
it to `.env` (auto-loaded by Bun and `netlify dev`) and uncomment what you need
to override; each value shown there is the built-in default.

## Local development

```sh
bun install
docker compose up -d postgres      # local Postgres matching .env.example DATABASE_URL

# option A: netlify dev — SPA + netlify function
bun run dev

# option B: run server + indexer separately (matches docker shape)
bun run migrate                    # create tables (needs DATABASE_URL)
bun run dev:server                 # :3001
bun run dev:indexer                # polls the default node
bun run dev                        # vite at :5173, proxy /api to :3001 if needed
```

## Layout

```
src/                     React SPA
server/                  Hono backend (GET /api/telemetry, /health, SPA fallback)
indexer/                 Long-running poller
api/db/                  DatabaseAdapter (Postgres via Kysely) + migrations
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
