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

Then open <http://localhost:3001>. PID 1 is `tini`; its single child is the
process supervisor (`deploy/entrypoint.ts`), which runs `migrate` before starting
the server + indexer (toggle either with `RUN_SERVER`/`RUN_INDEXER`). The image
is built from the `prod` stage of `deploy/Dockerfile` with the repository root as
the build context (`docker build --target prod -f deploy/Dockerfile .`).

## Configuration reference

Every environment variable — names, defaults, components, and what they do — is
documented in [`.env.example`](.env.example), the single source of truth. Copy it
to `.env` (auto-loaded by Bun and `netlify dev`) and uncomment what you need to
override; each value shown there is the built-in default.

## Local development

The whole stack runs in containers (the host needs no JS runtime). One command
brings up Postgres + server + indexer + frontend — supervised by tini +
`deploy/entrypoint.ts`, the same supervisor as prod — with the source
bind-mounted for hot reload (`bun --watch` backends, vite HMR for the SPA):

```sh
./run dev          # build + start everything; open http://localhost:5173
./run down         # stop it (./run down -v also wipes the postgres volume)
```

The SPA is on :5173 and proxies `/api` to the hono server on :3001. Point
`QUIP_VALIDATOR_RPC_URLS` (in `.env`) at a reachable node to index real chain
data; left unset, the indexer just retries while the SPA + server still work.

To exercise the degraded Netlify function path specifically, use
`./run bun run dev:netlify`.

## Layout

```
apps/
  frontend/   @quip/frontend  React SPA (+ index.html, vite.config.ts, .ladle/, netlify.toml)
  server/     @quip/server    Hono app — createApp() — + Bun & Netlify adapters (netlify/)
  indexer/    @quip/indexer   long-running substrate poller (@polkadot/*)
packages/
  shared/     @quip/shared    zero-dependency shared code (telemetry types today)
  core/       @quip/core      DatabaseAdapter (Postgres via Kysely) + miner-api + migrations
deploy/       Dockerfile (dev+prod stages), docker-compose.yml (dev stack), entrypoint.ts (tini-supervised process manager)
docs/         schema, plans, API specs, sample telemetry captures
.gitlab-ci.yml  Lint + typecheck + multi-arch buildx publish
```

Internal packages export their TypeScript source directly (Turborepo's
"Just-in-Time" pattern) — no build step; Bun, Vite, and esbuild transpile on use.
The frontend does not declare `@polkadot/*`, so the substrate worker can never
leak into the SPA bundle (the `verify:no-polkadot-in-bundle` guard backs this up).

## Commands

The host has no JS runtime, so everything runs through `./run` (see the script
header for the full list):

```sh
./run dev          # full dev stack (postgres + server + indexer + frontend)
./run build        # build the production container image (the published artifact)
./run typecheck    # per-package tsc --noEmit
./run test         # bun:test across every workspace
./run format       # prettier --write
```

Note the two senses of "build": `./run build` builds the deployable **container
image**, whereas the in-image `bun run build` produces the **SPA**
(`apps/frontend/dist`) — that's what the Dockerfile's frontend stage runs.

## License

AGPL-3.0-or-later.
