# Quip Dashboard

Post-quantum mining telemetry dashboard for the Quip network. Visualises block
production, mining times, compute usage, and active nodes across CPU, GPU, and
QPU miners.

**Stack:** React, Vite, Tailwind CSS v4, Nivo charts, Zustand, Hono, Bun.
Organised as a Bun-workspaces monorepo (`apps/*` + `packages/*`).

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
                               └──────────────────┬───────────────────┘
                                                  │ reads
                                                  ▼
                                   ┌─────────────────────────────┐
                                   │  Hono app — createApp()     │   one implementation
                                   │  GET /api/telemetry, /health│   (@quip/server)
                                   └──────┬───────────────┬──────┘
                          Bun adapter     │               │     serverless adapter
                       (apps/server/      ▼               ▼      (apps/server/
                        main.ts, docker)  ─               ─       netlify/, prod)
                                          └───────┬───────┘
                                                  ▼
                                       ┌──────────────────────┐
                                       │  React dashboard SPA │  (@quip/frontend)
                                       └──────────────────────┘
```

The **indexer** is a long-running process that polls a quip node's v0.1 telemetry
REST API and writes blocks + node snapshots to a Postgres datastore. The SPA
reads from that datastore through one HTTP endpoint — `GET /api/telemetry` —
served by a **single Hono app** (`createApp()` in `@quip/server`). That one app
is fronted by two thin adapters: `apps/server/main.ts` (`Bun.serve`, used in
docker) and `apps/server/netlify/telemetry.ts` (a Netlify function that just
calls `app.fetch`, used in production). They are the same implementation, not two.

## Setup paths

There are two supported deployment paths.

### 1. Netlify + Supabase (production)

The SPA ships on Netlify; telemetry lives in Supabase Postgres; the indexer runs
on a separate always-on host (VM, fly.io, Railway, etc.).

**One-time setup**

1. **Supabase project.** Create a project at [supabase.com](https://supabase.com)
   and copy the Postgres connection string (Settings → Database → Connection
   string, "URI" format).
2. **Migrate schema.** From a machine with `DATABASE_URL` set:
   ```sh
   DATABASE_URL="postgresql://..." bun run migrate
   ```
3. **Netlify site config.** Because this is a monorepo, set:
   - **Base directory:** the repository root (leave as default) — so Netlify
     runs the workspace-aware `bun install` and the function can resolve
     `@quip/server`/`@quip/core`.
   - **Package directory:** `apps/frontend` — where Netlify finds `netlify.toml`.
   - Env var `DATABASE_URL` = the Supabase Postgres URI.
4. **Deploy.** `git push` to your Netlify-connected branch. Build command is
   `bun run build`; the function at `apps/server/netlify/telemetry.ts` delegates
   all `/api/telemetry*` requests to the Hono app, which reads from Supabase.

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

One image runs the indexer, the Hono API, and the SPA. It connects to a Postgres
instance (the dashboard runs only on Postgres).

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

Then open <http://localhost:3001>. The entrypoint (`deploy/entrypoint.ts`) runs
`migrate` before starting the server + indexer. The image is built from
`deploy/Dockerfile` with the repository root as the build context
(`docker build -f deploy/Dockerfile .`).

## Configuration reference

Every environment variable — names, defaults, components, and what they do — is
documented in [`.env.example`](.env.example), the single source of truth. Copy it
to `.env` (auto-loaded by Bun and `netlify dev`) and uncomment what you need to
override; each value shown there is the built-in default.

## Local development

```sh
bun install                                            # links the workspaces
docker compose -f deploy/docker-compose.yml up -d postgres   # local Postgres

# option A: netlify dev — SPA + netlify function (monorepo-filtered)
bun run dev                                             # netlify dev --filter @quip/frontend

# option B: run server + indexer separately (matches docker shape)
bun run migrate                                         # create tables (needs DATABASE_URL)
bun run dev:server                                      # @quip/server on :3001
bun run dev:indexer                                     # @quip/indexer polls the default node
```

## Layout

```
apps/
  frontend/   @quip/frontend  React SPA (+ index.html, vite.config.ts, .ladle/, netlify.toml)
  server/     @quip/server    Hono app — createApp() — + Bun & Netlify adapters (netlify/)
  indexer/    @quip/indexer   long-running substrate poller (@polkadot/*)
packages/
  shared/     @quip/shared    zero-dependency shared code (telemetry types today)
  core/       @quip/core      DatabaseAdapter (Postgres via Kysely) + miner-api + migrations
deploy/       Dockerfile, docker-compose.yml, entrypoint.ts (supervisor)
docs/         schema, plans, API specs, sample telemetry captures
.gitlab-ci.yml  Lint + typecheck + multi-arch buildx publish
```

Internal packages export their TypeScript source directly (Turborepo's
"Just-in-Time" pattern) — no build step; Bun, Vite, and esbuild transpile on use.
The frontend does not declare `@polkadot/*`, so the substrate worker can never
leak into the SPA bundle (the `verify:no-polkadot-in-bundle` guard backs this up).

## Scripts

All run from the repo root:

```sh
bun run typecheck     # per-package tsc --noEmit (+ the deploy entrypoint)
bun test              # bun:test across every workspace
bun run build         # vite build of @quip/frontend → apps/frontend/dist
bun run format:check  # prettier --check .
```

## License

AGPL-3.0-or-later.
