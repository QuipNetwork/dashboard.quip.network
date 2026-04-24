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
`IndexerState`, `DatabaseAdapter`, and `chainAnchors` cache, but each holds
its own `QuipClient` so rate-limit backoff in one worker does not stall the
other.

- **Tip worker** (`indexer/tip-worker.ts`) runs a tight poll loop: GET
  `/status` → GET `/epochs` → compute the tip epoch's owned block range →
  walk any new blocks → refresh the nodes snapshot on cadence → write
  observability. It only fetches blocks that belong to `status.latestEpoch`,
  so the dashboard sees at least one block of the live chain within a single
  poll interval.
- **Backfill worker** (`indexer/backfill-worker.ts`) walks the full
  canonical plan (every epoch except the tip), ordered canonical-chain-first
  and then dead forks. When every plan entry is fully indexed, it sleeps for
  `backfillIdleRecheckSec` (default 300s) before rebuilding the plan. That
  re-check catches chains that became dead forks mid-walk and new dead forks
  the node starts exposing later.
- **Orchestrator** (`indexer/main.ts`) spawns both workers under a shared
  `AbortController`. An `AuthError` in either worker aborts its sibling and
  exits with code 1. `SIGINT` / `SIGTERM` aborts both cleanly.

### Error handling

| Situation            | Behavior                                             |
| -------------------- | ---------------------------------------------------- |
| 304                  | no-op, sleep `pollIntervalSec`, continue             |
| 404 on a block       | warn, advance cursor, continue                       |
| 401                  | abort sibling worker, `process.exit(1)`              |
| 429                  | exponential backoff 5s → 60s (reset on success)      |
| 5xx / network error  | warn, sleep `pollIntervalSec`, retry                 |
| `SIGINT` / `SIGTERM` | finish iteration, persist cursors, disconnect, exit 0 |

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

| File                             | Covers                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `indexer/shared.test.ts`         | helpers: `buildCanonicalPlan`, stall tracker, `sleepInterruptible`, `saveStateSafely`                        |
| `indexer/tip-worker.test.ts`     | tip iteration: `ownedStart` seeding, epoch rollover, same-epoch advance, observability heartbeat, `replaceEpochStatus` |
| `indexer/backfill-worker.test.ts` | plan reordering, `markPlanEntriesDone`, tip-epoch filter, idle transition, `RateLimitError` rethrow, abort during walk |
| `indexer/main.test.ts`           | orchestration: both workers complete normally; `AuthError` aborts sibling; unhandled error returns 1         |
| `indexer/config.test.ts`         | flag / env parsing, validation, whitespace handling                                                          |
| `indexer/client.test.ts`         | `QuipClient` HTTP behavior, error mapping, big-int nonce quoting                                             |
| `indexer/state.test.ts`          | `IndexerState` load/save, schema-drift reset                                                                 |
