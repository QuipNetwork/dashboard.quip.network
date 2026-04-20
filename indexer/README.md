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

| Flag                    | Env                   | Default                               |
| ----------------------- | --------------------- | ------------------------------------- |
| `--node-url`            | `QUIP_NODE_URL`       | `https://qpu-1.nodes.quip.network`    |
| `--token`               | `QUIP_NODE_TOKEN`     | unset                                 |
| `--poll-interval`       | `POLL_INTERVAL_SEC`   | `8`                                   |
| `--nodes-refresh`       | `NODES_REFRESH_SEC`   | `45`                                  |
| `--backfill-from-epoch` | `BACKFILL_FROM_EPOCH` | unset (starts at node's latest epoch) |
| `--once`                | —                     | `false`                               |
| `--verbose`             | `VERBOSE=1`           | `false`                               |

Database configuration is read from env via `api/db`:

| Env            | Default               |
| -------------- | --------------------- |
| `DB_ADAPTER`   | `sqlite`              |
| `DATABASE_URL` | (Postgres only)       |
| `SQLITE_PATH`  | `./data/telemetry.db` |

## How it works

Each iteration:

1. `GET /api/v1/telemetry/status` with `If-None-Match: <last status etag>`.
   A `304` short-circuits the iteration.
2. If a new epoch appears or the indexer is booting fresh, the cursor resets
   to `blockIndex = 0` on the latest epoch (or on `BACKFILL_FROM_EPOCH`).
3. While `cursor.blockIndex < status.latestBlockIndex`, fetches
   `/epochs/{epoch}/blocks/{index+1}` and writes via `db.insertBlock`.
   404s advance the cursor and log a warning (pruned block).
4. If `nodesRefreshSec` has elapsed since the last nodes fetch, calls
   `/nodes` with its own etag and upserts via `db.upsertNodes`.
5. Persists the cursor + etags via `db.saveCursor`.

### Error handling

| Situation            | Behavior                                             |
| -------------------- | ---------------------------------------------------- |
| 304                  | no-op, sleep `pollIntervalSec`, continue             |
| 404 on a block       | warn, advance cursor, continue                       |
| 401                  | log with `QUIP_NODE_TOKEN` hint, `process.exit(1)`   |
| 429                  | exponential backoff 5s → 60s (reset on success)      |
| 5xx / network error  | warn, sleep `pollIntervalSec`, retry                 |
| `SIGINT` / `SIGTERM` | finish iteration, persist cursor, disconnect, exit 0 |

### Big-int nonce

`quantum_proof.nonce` is a `u64` and regularly exceeds
`Number.MAX_SAFE_INTEGER`. `client.getBlock` pre-quotes the bare integer
(`"nonce":14191405648832262461` → `"nonce":"14191405648832262461"`) before
`JSON.parse`, and `rawBlockToRecord` stores it as a string.

## Tests

```bash
bun test indexer/loop.test.ts
```

Tests stub `fetch` and use an in-memory fake `DatabaseAdapter`; they do not
touch SQLite.
