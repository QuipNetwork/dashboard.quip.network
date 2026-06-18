# Indexer

Long-running worker that fuses two sources into Postgres: the **substrate
validator RPC** (canonical chain state — blocks, miners, difficulty, validators,
BABE epoch, on-chain node descriptors) and the **local miner REST API**
(per-node self-identity and miner stats). The dashboard server reads what this
worker writes.

## Running

```bash
# one-shot (exits after a single iteration)
bun run apps/indexer/main.ts --once

# long-running, against a reachable validator (dev)
bun run apps/indexer/main.ts \
  --validator-rpc-urls ws://127.0.0.1:9944 \
  --poll-interval 8

# via the workspace script (uses QUIP_VALIDATOR_RPC_URLS from .env)
bun run dev:indexer
```

### Reconstructing firstSeen

The live worker snapshots the registry at the finalized head, so a from-scratch
rebuild of `node_descriptors` seeds each node's `firstSeen` from its latest
`updated_at`, not its first registration. This one-shot command recovers the
true value by binary-searching each account's first-appearance block —
O(accounts × log(head)) reads, not a per-block walk. It requires an **archive
node** (it reads historical state) and only ever lowers `firstSeen`, so it's
safe to re-run.

```bash
bun run reconstruct-firstseen
# or, against a specific archive endpoint:
QUIP_VALIDATOR_RPC_URLS=wss://archive:443 bun run reconstruct-firstseen
```

## Flags / env

| Flag                                | Env                                       | Default                    |
| ----------------------------------- | ----------------------------------------- | -------------------------- |
| `--validator-rpc-urls`              | `QUIP_VALIDATOR_RPC_URLS`                 | `ws://quip-validator:9944` |
| `--poll-interval`                   | `POLL_INTERVAL_SEC`                       | `8`                        |
| `--nodes-refresh`                   | `NODES_REFRESH_SEC`                       | `45` (informational)       |
| `--stall-warn-after`                | `STALL_WARN_AFTER_SEC`                    | `600` (0 disables)         |
| `--substrate-rpc-timeout`           | `QUIP_VALIDATOR_RPC_TIMEOUT_MS`           | `15000`                    |
| `--substrate-reconnect-max-backoff` | `QUIP_VALIDATOR_RECONNECT_MAX_BACKOFF_MS` | `60000`                    |
| `--substrate-babe-poll`             | `QUIP_VALIDATOR_BABE_POLL_SEC`            | `30`                       |
| `--substrate-chain-poll`            | `QUIP_VALIDATOR_CHAIN_POLL_SEC`           | `6`                        |
| `--operator-account`                | `QUIP_OPERATOR_ACCOUNT`                   | unset                      |
| `--once`                            | —                                         | `false`                    |
| `--verbose`                         | `VERBOSE=1`                               | `false`                    |

`QUIP_VALIDATOR_RPC_URLS` is comma-separated; the substrate / descriptor workers
round-robin through the list on connect failure, and index 0 is the default any
other code path uses (e.g. deriving the local miner-REST URL before an on-chain
descriptor has landed).

Database configuration is read from env via `@quip/core/db`:

| Env            | Default                               |
| -------------- | ------------------------------------- |
| `DATABASE_URL` | Required — Postgres connection string |

## How it works

Three concurrent async workers run in one process under a shared
`AbortController`. They share one `IndexerState` and `DatabaseAdapter`.

Each worker is a class implementing the shared `Worker` contract
(`run(signal)`, in `apps/indexer/core/worker.ts`); the connection-invariant deps
(`WorkerContext`) and the generic rxjs bridges (`apps/indexer/core/rx.ts`) are
shared across all three.

Layout: each worker owns a directory (`substrate/`, `tip/`, `descriptor/`); the
external-system clients live under `clients/` (the substrate RPC cluster behind
the `clients/substrate-client/` barrel, and the miner REST `clients/miner-client.ts`);
and the shared worker framework + cross-cutting infra (`worker.ts`, `rx.ts`,
`config.ts`, `state.ts`, `chain-state.ts`, test helpers) sit under `core/`.

- **Substrate worker** (`apps/indexer/substrate/`) subscribes to the validator
  over WSS and is the canonical source of `BlockRecord` rows plus the chain
  surfaces (`quantum_pow.Miners`, difficulty, session validators, BABE epoch).
  An rxjs pipeline — `defer(connect) → merge(chainHead$, blocks$, polls$)`
  wrapped in `retry` (reconnect + URL rotation) and `takeUntil(abort)`.
  Failures self-heal via the exponential-backoff reconnect loop.
- **Descriptor worker** (`apps/indexer/descriptor/`) snapshots the finalized
  `MinerRegistry.NodeDescriptors` storage written by operators running
  `quip-miner identify`, populating on-chain node descriptors. A
  `timer(0, interval) → exhaustMap(scan finalized head)` loop over its own
  client lifecycle. Each registry entry carries its own `updatedAt`
  provenance and `node_descriptors` is keyed per-account, so one read at the
  finalized head yields what walking every block would converge to — at
  O(nodes) per poll, independent of chain height.
- **Tip worker** (`apps/indexer/tip/`) polls the local miner REST surface for
  self-identity and miner stats and flushes the observability heartbeat each
  iteration so the dashboard knows the indexer is alive. An rxjs
  `timer(0, interval) → exhaustMap(iterate) → takeUntil(abort)` loop.
- **Orchestrator** (`apps/indexer/main.ts`) spawns the workers via
  `runWorkers`, which takes a `WorkerSpec[]` (worker + `fatal` flag). The tip
  worker is the only fatal one — its failure aborts the siblings and exits
  non-zero; substrate and descriptor failures are non-fatal and recover on
  their own. `SIGINT` / `SIGTERM` aborts cleanly.

### Big-int nonce

`quantum_proof.nonce` is a `u64` and regularly exceeds
`Number.MAX_SAFE_INTEGER`. `client.getBlock` pre-quotes the bare integer
(`"nonce":14191405648832262461` → `"nonce":"14191405648832262461"`) before
`JSON.parse`, and `rawBlockToRecord` stores it as a string.

## Tests

```bash
bun test apps/indexer/
```

Tests stub `fetch` and use a real adapter over an in-process Postgres (pglite),
so they run self-contained with no external database.

| File                                     | Covers                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/indexer/tip/iteration.test.ts`     | tip iteration: self-identity poll, miner stats, observability heartbeat                                             |
| `apps/indexer/tip/worker.test.ts`        | tip loop cadence: immediate-first-run, prompt abort, once mode, heartbeat fallback                                  |
| `apps/indexer/substrate/worker.test.ts`  | substrate event subscription, canonical block writes, reconnect backoff                                             |
| `apps/indexer/descriptor/iteration.test.ts` | descriptor scan: `MinerRegistry.NodeDescriptors` registry snapshots                                              |
| `apps/indexer/descriptor/reconstruct.test.ts` | firstSeen reconstruction: binary-search first-appearance, O(log) reads, LEAST guard, stale-row skip            |
| `apps/indexer/descriptor/worker.test.ts` | descriptor loop: head snapshot, scan cost independent of chain height, head-advance pickup, URL rotation, dead-socket reconnect |
| `apps/indexer/main.test.ts`              | orchestration: workers run concurrently; a tip failure aborts siblings; substrate/descriptor failures are non-fatal |
| `apps/indexer/core/config.test.ts`       | flag / env parsing, validation, whitespace handling                                                                 |
| `apps/indexer/clients/miner-client.test.ts` | `QuipClient` HTTP behavior, error mapping, big-int nonce quoting                                                 |
| `apps/indexer/core/state.test.ts`        | `IndexerState` load, observability seeding on restart                                                               |
| `apps/indexer/clients/substrate-client/client.test.ts` | substrate client transport, event parsing                                                             |
