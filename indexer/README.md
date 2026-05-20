# Indexer

Long-running worker that polls a Quip node's telemetry REST API and persists
blocks and node snapshots into the configured database (SQLite or Postgres).

## Running

```bash
# one-shot (exits after a single iteration)
bun indexer/main.ts --once

# long-running poll loop
bun indexer/main.ts \
  --node-url https://qpu-1.nodes.quip.network \
  --token "$QUIP_NODE_TOKEN" \
  --poll-interval 8 \
  --nodes-refresh 45
```

## Flags / env

| Flag              | Env                 | Default                            |
| ----------------- | ------------------- | ---------------------------------- |
| `--node-url`      | `QUIP_NODE_URL`     | `https://qpu-1.nodes.quip.network` |
| `--token`         | `QUIP_NODE_TOKEN`   | unset                              |
| `--poll-interval` | `POLL_INTERVAL_SEC` | `8`                                |
| `--nodes-refresh` | `NODES_REFRESH_SEC` | `45`                               |
| `--once`          | —                   | `false`                            |
| `--verbose`       | `VERBOSE=1`         | `false`                            |

Database configuration is read from env via `api/db`:

| Env            | Default               |
| -------------- | --------------------- |
| `DB_ADAPTER`   | `sqlite`              |
| `DATABASE_URL` | (Postgres only)       |
| `SQLITE_PATH`  | `./data/telemetry.db` |

## How it works

Two concurrent async workers run in one process. They share the same
`IndexerState` and `DatabaseAdapter`. Canonical block data comes from the
substrate worker (chain events); the tip worker only refreshes node
self-identity, miner stats, and observability heartbeat.

- **Tip worker** (`indexer/tip-worker.ts`) runs a poll loop against the
  node's REST surface: GET `/status` for self-identity, fetch miner stats,
  and flush the observability heartbeat every iteration so the dashboard
  knows the indexer is alive.
- **Substrate worker** (`indexer/substrate-worker.ts`, opt-in via
  `QUIP_VALIDATOR_RPC_URL`) subscribes to the chain over WSS and is the
  canonical source of `BlockRecord` rows. When the env var is unset, the
  indexer runs in REST-only degraded mode and the chain surfaces stay
  null/empty.
- **Orchestrator** (`indexer/main.ts`) spawns the workers under a shared
  `AbortController`. An `AuthError` from the tip worker aborts substrate
  and exits with code 1; substrate failures are non-fatal and the tip
  worker keeps running. `SIGINT` / `SIGTERM` aborts cleanly.

### Error handling

| Situation            | Behavior                                        |
| -------------------- | ----------------------------------------------- |
| 401 (tip)            | abort substrate, `process.exit(1)`              |
| 401 (substrate)      | log, keep tip running                           |
| 429                  | exponential backoff 5s → 60s (reset on success) |
| 5xx / network error  | warn, sleep `pollIntervalSec`, retry            |
| `SIGINT` / `SIGTERM` | finish iteration, disconnect, exit 0            |

### Big-int nonce

`quantum_proof.nonce` is a `u64` and regularly exceeds
`Number.MAX_SAFE_INTEGER`. `client.getBlock` pre-quotes the bare integer
(`"nonce":14191405648832262461` → `"nonce":"14191405648832262461"`) before
`JSON.parse`, and `rawBlockToRecord` stores it as a string.

## Tests

```bash
bun test indexer/
```

Tests stub `fetch` and use an in-memory fake `DatabaseAdapter`; they do not
touch SQLite.

| File                                | Covers                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `indexer/tip-worker.test.ts`        | tip iteration: self-identity poll, miner stats, observability heartbeat                             |
| `indexer/substrate-worker.test.ts`  | substrate event subscription, canonical block writes, reconnect backoff                             |
| `indexer/main.test.ts`              | orchestration: tip alone or with substrate; `AuthError` from tip aborts substrate; substrate failures are non-fatal |
| `indexer/config.test.ts`            | flag / env parsing, validation, whitespace handling                                                 |
| `indexer/client.test.ts`            | `QuipClient` HTTP behavior, error mapping, big-int nonce quoting                                    |
| `indexer/state.test.ts`             | `IndexerState` load, observability seeding on restart                                               |
| `indexer/substrate-client.test.ts`  | substrate client transport, event parsing                                                           |
