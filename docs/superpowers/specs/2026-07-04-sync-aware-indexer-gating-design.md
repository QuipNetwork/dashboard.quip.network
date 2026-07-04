# Sync-Aware Indexer Gating

**Date:** 2026-07-04
**Status:** Approved (design), implementation pending

## Problem

The indexer starts its full pipeline the moment the WebSocket connects. A
validator doing *major sync* is already saturating its own I/O importing
blocks; the indexer's backfill dispatch (2 lanes × `backfillBlocksPerSec`,
`BACKFILL_CONCURRENCY` parallel `getBlock` calls), reconciler cross-checks,
and snapshot scans compete for the same node resources and stall its
synchronization.

## Requirements

- Detect when the connected validator is out of sync (at startup and mid-run).
- Pause heavy indexer work until the node reports synced.
- Keep cheap chain-head subscriptions alive so the dashboard shows live sync
  progress (chosen over full-stop and disconnect alternatives).
- Tell the user: indexer logs + dashboard SyncIndicator state.

## Approach (chosen: pause in place)

Pause work at existing throttle points while preserving all pipeline state
(queue contents, coverage tracking, walker plans). Rejected alternatives:

- **rx-level teardown** (`gate$ → switchMap`): every sync flap re-runs the
  reconciler's boot probing and re-primes the walker; the dispatcher's pending
  coverage flush needs special teardown handling.
- **Startup-only gate** (`await waitForSync()` before pipeline start): misses
  the mid-run "node fell out of sync" half of the requirement.

## Design

### 1. Detection — `SyncGate` (new, `apps/indexer/substrate/sync-gate.ts`)

- New `SubstrateClient` method
  `getSyncState(): Promise<{ isSyncing: boolean; peers: number; currentBlock: number | null; highestBlock: number | null }>`
  wrapping `system_health` + `system_syncState` (syncState is best-effort;
  null fields when the RPC is absent).
- `SyncGate` is a `ConnectionStream` like its siblings:
  `timer(0, pollMs) → exhaustMap(check)`. Poll every 5s while syncing, every
  30s once synced.
- Hysteresis: the gate opens only after **2 consecutive** `isSyncing: false`
  polls (nodes flap the flag near the tip); it closes immediately on the first
  `isSyncing: true`.
- Log gate transitions:
  `[indexer/substrate] validator is syncing (406,173/512,000) — pausing indexing`
  and `…synced — resuming`.

### 2. Pausing — three consult points, no lifecycle changes

- `QueueCore` gets a `gated: () => boolean` option; `tryPull` returns
  `{ retryAtMs: now + pollMs }` when gated — the dispatcher already sleeps on
  retry results.
- `Reconciler.tick()` and `SnapshotScheduler`'s scan return early while gated.
- `ChainHeadWriter` and `TipEnqueuer` subscriptions keep running; tip blocks
  enqueued during the pause wait in the queue and drain on resume.

### 3. Telling the user

- New `IndexerObservability` fields: `nodeSyncing: boolean`,
  `nodeSyncCurrentBlock` / `nodeSyncHighestBlock` (u64-as-string, null when
  unknown) — flow through the existing observability → `/api/telemetry` →
  telemetry store path.
- `SyncIndicator` gains a distinct **"Node syncing"** state (visually between
  "connected" and "stalled") with progress when available, so a syncing
  validator isn't misreported as a stalled indexer.

### 4. Error handling

- `getSyncState` failure ≠ syncing: on RPC error the gate keeps its last
  state (don't pause a healthy pipeline because one health poll timed out).
  Warn on repeated failures.

### 5. Testing

- `FakeSubstrateClient` gets a programmable sync state.
- Unit tests: gate hysteresis, queue gating, reconciler skip, observability
  propagation.
- Integration-style test: connect while "syncing", verify no backfill pulls,
  flip synced, verify the queue drains.

## Out of scope

The `processFinalizedBlock` decode failure ("Signed Extrinsics are currently
only available for ExtrinsicV4" on historical blocks) is a separate bug fix:
the `HybridExtrinsicSignature` registration must apply to the per-block
registries polkadot.js creates for older runtime specVersions, not only the
boot-time registry.
