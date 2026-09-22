# Quip Dashboard

Post-quantum mining telemetry dashboard for the Quip network. The service
visualises block production, mining times, compute usage, and active nodes
across CPU, GPU, and QPU miners.

The backend is a single Rust binary. It runs a chain indexer, a miner poller,
and the telemetry HTTP API. A lightweight React single-page app (SPA) reads
that API. The combined production image runs the backend, the Caddy front
door, and the syslog collector under one supervisor.

## Storage model

The default storage engine is Turso. With no `DATABASE_URL`, the backend opens a
local Turso database file at `/data/dashboard.db`. When `DATABASE_URL` is a
valid Postgres URL, the backend opens that Postgres server instead. The two
backends use the same domain operations and the same serialized single-writer
boundary. A Postgres advisory lock guards the writer, and a local file lock
guards the embedded database.

An empty `DATABASE_URL` selects Turso. A valid Postgres URL selects Postgres.
Any other value fails startup. An invalid URL never falls back to local
storage. The migration ledger preserves the historical Kysely names and
execution timestamps, so an existing database migrates forward without a wipe.
`docker compose -f deploy/docker-compose.yml -f
deploy/docker-compose.postgres.yml up --build` starts a local Postgres overlay.

## Runtime modes

Two modes run from the same binary.

**Full mode (default).** The backend runs the HTTP API, the indexer, miner
polling, and the watchdog. It opens storage, binds to the selected chain, and
polls the local miner.

**API-only mode.** Set `RUN_INDEXER=false`. This requires Postgres. The backend
opens a read-only Postgres pool and takes no writer lease. It contacts no chain
or miner worker. Its HTTP API and watchdog tasks remain active. It needs a
current schema. Use it to serve a shared telemetry database deployed
elsewhere.

An API-only deployment republishes qblock files from the shared database every
hour, so Recent Blocks and the participation views work there. Each replica
writes its own file tree under `QUIP_DATA_DIR`, which defaults to `/data`. The
replicas share only the database. Do not point two deployments at one file
volume.

An API-only deployment serves no Current Attempts data. That view comes from
polling a miner over HTTP, which this mode does not do. The telemetry response
reports the gap as `capabilities.minerDispatch: false`, and the panel states it
in the user interface.

## Components

Three Rust crates form the workspace. Dependency direction is
`dashboard-model <- dashboard-store <- quip-dashboard`.

| Crate             | Role                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `dashboard-model` | Public serde types that match the shared telemetry contract.                              |
| `dashboard-store` | Storage over Turso or Postgres, plus migrations.                                          |
| `quip-dashboard`  | Chain reader, indexer, miner service, HTTP router, health, supervisor, and both binaries. |

The chain reader uses one WebSocket connection and checks genesis
before use. The indexer admits at most 64 blocks of work, with eight slots
reserved for live work. Backfill admits one block per second. RPC operations
run through four shared slots, with two reserved for backfill. Health exposes
liveness and readiness decisions over the HTTP API.

The four indexable block domains are winners, difficulty, participation, and
authorship. Each domain keeps its own persisted generation and coverage.
Missing historical nonce or difficulty data stays uncovered. The indexer records
that absence to prevent repeated reads. Explicit reindexing clears those records.

## Production image

The combined image runs three services under one supervisor:

- `quip-dashboard serve`, the backend.
- `caddy run`, the front door that serves the built SPA and proxies `/api`.
- `deploy/syslog-ng/rotate.sh`, the log collector, which rotates
  `/logs/quip-node.log`.

`tini` is PID 1. Its single child is `entrypoint.sh`, which validates the
`PUID` and `PGID`, prepares `/data` and `/logs`, drops privilege via
`s6-setuidgid`, and execs `quip-dashboard-supervisor`. The supervisor starts
the collector, backend, and Caddy in that order. The backend migrates the
database before it admits API requests.

The image builds the SPA in a locked Bun stage and the Rust binaries in a
musl Alpine stage. The image includes Postgres support and accepts a `DATABASE_URL`. The frontend static assets install at `/app/frontend`, and
Caddy serves them without a JavaScript runtime. The image carries no
TypeScript source or JS tooling.

Build with:

```sh
./run build        # builds the production container image
docker build -f deploy/Dockerfile --target prod -t quip-dashboard .
```

## Local development

The host needs no Rust or JS runtime. `./run` builds and runs the stack inside
containers. It selects Podman when present, otherwise Docker.

```sh
./run dev          # build + start the backend and the Vite dev frontend
./run down [-v]    # stop the dev stack; -v also removes the data volume
./run logs         # follow logs from the running stack
```

`./run dev` starts the combined production image (`deploy/docker-compose.yml`)
and a separate Bun frontend that watches mounted source and proxies API
requests through the backend's Caddy. The SPA is at `http://localhost:5173`.
The default embedded database needs no external service. Start the Postgres
overlay for a real Postgres backend.

The repository contains the Rust backend in `crates/` and the frontend SPA in
`apps/frontend`. The old TypeScript backend was removed at cutover; the
combined image ships the Rust implementation.

Rust development runs through the Rust dev image:

```sh
./run rust cargo test --locked -p dashboard-model
./run rust cargo clippy --locked --workspace --all-targets -- -D warnings
./run rust cargo fmt --all -- --check
```

## Operator commands

The backend exposes explicit administration commands. Run them against a
deployed service or a local database.

| Command                         | Purpose                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `serve`                         | Run HTTP, indexing, miner polling, and the watchdog.                             |
| `migrate [up\|status\|dry-run]` | Apply additive local migrations without contacting a validator. Default is `up`. |
| `list-indexables`               | List the four block domains and their persisted generation and coverage.         |
| `reindex [domains]`             | Drop owned history for the domains. No argument selects all four.                |
| `reconstruct-firstseen`         | Reconstruct earliest descriptor timestamps from historical chain state.          |
| `healthcheck`                   | Query the running process liveness endpoint. It never opens the database.        |

`migrate status` and `migrate dry-run` use the read-only inspection path and
do not open a writer. `healthcheck` probes `/api/live` on `PORT` (default 3001) and never loads configuration or opens storage. `reconstruct-firstseen`
uses the real bounded indexer code and requires a reachable chain.

The four indexable domains are winners, difficulty, participation, and
authorship.

## Configuration

[`.env.example`](.env.example) lists the environment variables and their defaults. Configuration debug output redacts Postgres
URLs and upstream URLs. A malformed value names the key without echoing its
value.

## Health

The backend exposes two routes over the HTTP API.

`GET /api/live` reports process liveness. It returns 200 when the required
tasks and the watchdog are alive. It fails after 60 seconds of local startup
or a 15-second watchdog gap.

`GET /api/health` reports readiness. It follows `/api/live` and adds
dependencies and progress checks. With indexing on, readiness requires both a
working chain subscription and a recent successful miner poll. API-only mode
requires HTTP and the watchdog only.

A required task exit fails liveness. An advancing finalized head without a
committed block for 90 seconds fails readiness. `HealthSnapshot.ok` follows
readiness. The live route sets its copied snapshot `ok` field from liveness
before serialization.

## Project layout

```
crates/
  dashboard-model/     public telemetry types
  dashboard-store/     storage over Turso or Postgres + migrations
  quip-dashboard/      chain, indexer, miner, http, health, supervisor
apps/
  frontend/            React SPA
deploy/
  Dockerfile           combined production + dev image
  docker-compose.yml   local dev stack (embedded-first)
  docker-compose.postgres.yml   optional Postgres overlay
  entrypoint.sh        privilege drop + supervisor launch
  Caddyfile            front door for the combined image
  syslog-ng/           log collector + rotation
docs/                  schema, plans, API specs, sample telemetry
```

## License

AGPL-3.0-or-later.
