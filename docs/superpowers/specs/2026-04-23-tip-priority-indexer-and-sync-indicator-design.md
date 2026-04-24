# Tip-priority indexer & synchronizing status indicator

**Status:** Design approved, ready for implementation plan
**Date:** 2026-04-23
**Current branch:** `fix/epoch-hash-ids`. A dedicated feature branch will be cut at the start of implementation.

## Motivation

On `qpu-1.nodes.quip.network` (and any node with accumulated dead-fork history), the dashboard shows the warning *"Indexer is on a different epoch than the polled node"* and the epoch selector lists no `(live)` option. Root cause: the indexer walks its canonical plan in `(chainAnchor, ownedStart)` order — chain-1-hash alphabetical — so dead forks get indexed before the live chain. No block in `latestEpoch` is persisted until the entire dead-fork history is walked, which can take hours.

Users have no way to tell whether the dashboard is broken, the node is broken, or the indexer is still catching up. The header has no status surface at all during the healthy path.

## Goals

1. Guarantee that at least one block of the node's current `latestEpoch` is indexed within one poll after the indexer starts (modulo the node being reachable). The `(live)` tag in the epoch selector must appear immediately.
2. Keep historical backfill running concurrently in the background, ordered so the live chain's prior epochs fill in before dead forks.
3. Surface the indexer's state to users via a top-left header indicator covering five states: Connecting, Synchronizing, Backfilling, Live, Stalled.

## Non-goals

- No change to block attribution or per-chain owned-range semantics — the existing `buildCanonicalPlan` logic is correct and is reused as-is.
- No addition of `backfillPending` counts or progress percentages. Deferred per YAGNI; can be added later if operators ask for it.
- No node-side changes. The Quip node's telemetry API is treated as a fixed contract.
- No `SCHEMA_VERSION` bump and no forced re-index of `blocks` / `epoch_status`. Existing data stands.

## Architecture

The indexer goes from a single poll loop to **two concurrent async workers** running in one Node.js process. They share an `IndexerState`, a `DatabaseAdapter`, and the `chainAnchors` cache, but use **separate `QuipClient` instances** so rate-limit backoff is isolated between them.

```
┌─── quip-indexer (single process) ─────────────────────────────────┐
│                                                                   │
│   TipWorker  ──► QuipClient(tip)     ──► Quip node /status,       │
│     │                                      /epochs,               │
│     ├── tipCursor                          /blocks/{epoch}/{idx}  │
│     ├── stall tracker                                             │
│     ├── /status heartbeat (shared) DatabaseAdapter ──► SQLite/PG  │
│     └── replaceEpochStatus        (shared) chainAnchors cache     │
│                                                                   │
│   BackfillWorker ──► QuipClient(backfill) ──► Quip node (same)    │
│     ├── backfillCursor                                            │
│     ├── plan = buildCanonicalPlan(…).filter(e ≠ tipEpoch)         │
│     ├── ordered: canonical chain first, then dead forks           │
│     └── idle-rechecks every 5 min when plan fully indexed         │
│                                                                   │
│   shared: IndexerState { tipCursor, backfillCursor,               │
│                          chainAnchors, stall, etags }             │
└───────────────────────────────────────────────────────────────────┘
             │ writes observability JSON blob each iteration
             ▼
    meta.indexer_observability  ──►  /api/telemetry  ──►
      src/lib/staleness.ts  ──►  SyncIndicator (header left, layout B)
                            ──►  RecentBlocksTable banner (existing)
```

### Architectural invariants

1. **Tip worker is authoritative for "what is the live tip right now?"** It is the only worker that reads `/status`, writes the `lastStatusFetchAt` heartbeat, runs the stall tracker, and calls `replaceEpochStatus`.
2. **Backfill worker is authoritative for historical completeness.** It walks the filtered plan, handles dead forks plus prior canonical epochs, and is the only worker that can leave `backfillEpoch !== null`.
3. **Both workers write through idempotent `insertBlock`.** Race on the same `(epoch, blockIndex)` — possible during a chain switch where in-flight backfill touches what just became the tip — resolves at the DB layer with no explicit coordination.
4. **Both workers write the observability blob.** Tip worker writes at the end of every iteration (including no-body / error paths — the blob carries the heartbeat). Backfill worker writes on every plan-entry completion and when it transitions to idle. The blob is a full-replace write that snapshots the in-memory `IndexerState` at write time — last writer wins, but the in-memory state (not the DB blob) is the source of truth both workers read from, so consecutive writes produce consistent blobs.
5. **Error isolation at the worker level.** Each worker has its own top-level `try/catch` that logs and restarts its own loop. `AuthError` remains fatal and signals the sibling via a shared `AbortController` before `main.ts` runs `db.disconnect()`.

### Why two async tasks, not worker_threads or processes

The indexer workload is I/O-bound (HTTP polls + DB writes). Node.js's single event loop interleaves the two `await`-heavy loops naturally. Worker threads would add message-passing overhead, doubled DB handle setup, and zero CPU-parallelism benefit. Two processes would double the deploy surface (two containers, two heartbeats) and force coordination through the DB only.

## Data model

### `src/types/telemetry.ts` — `IndexerObservability`

Replace (no shim, no backwards-compatible alias):

```ts
export interface IndexerObservability {
  nodeLatestEpoch: EpochId;
  nodeLatestBlockIndex: number;

  // Tip follower — latest-epoch cursor. tipEpoch === nodeLatestEpoch
  // && tipBlockIndex === nodeLatestBlockIndex  → tip caught up.
  tipEpoch: EpochId | null;
  tipBlockIndex: number;

  // Backfill worker — null when idle (no outstanding plan work);
  // otherwise the epoch currently being walked.
  backfillEpoch: EpochId | null;
  backfillBlockIndex: number;

  lastStatusFetchAt: string;         // tip-worker heartbeat (ISO 8601)
  lastBlockInsertAt: string | null;  // either worker, most recent insert
}
```

### `indexer/state.ts` — `IndexerState`

```ts
interface IndexerState {
  tipCursor:      { epoch: EpochId | null; blockIndex: number };
  backfillCursor: { epoch: EpochId | null; blockIndex: number };

  chainAnchors: Map<EpochId, string>;        // shared read/write; atomic under JS event loop
  stall:        { lastObserved, lastAdvanceAtMs, lastWarnAtMs };  // tip worker owns
  etags:        { nodes: string | null };    // tip worker owns (nodes refresh lives on tip poll)
  observability:{ lastBlockInsertAt: string | null };   // either worker updates
}
```

The persisted `state.json` gains a schema-version field. On startup, if the on-disk version does not match the new code's expected version (or if `tipCursor`/`backfillCursor` do not parse), the file is **deleted** and both workers seed from scratch. Existing blocks in the DB are untouched; idempotent `insertBlock` absorbs any redundant re-fetch during the first post-deploy run.

### DB layer

`DatabaseAdapter.setIndexerObservability(obs)` signature follows the new `IndexerObservability` shape. The observability blob lives in the existing `meta` table as a JSON value; no column additions. If the server reads an old-shape blob after deploy but before the first new poll, parsing returns `null`, the UI renders "Connecting…", and the tip worker's next successful poll overwrites the blob with the new shape.

**`SCHEMA_VERSION` does not bump.** `blocks`, `epoch_status`, `nodes_snapshot`, and `indexer_state` tables are unchanged.

### `src/lib/staleness.ts` — `ChainHealth` expanded

```ts
export type HealthLevel = "healthy" | "warning" | "stalled";
export type SyncStage  = "connecting" | "synchronizing" | "backfilling" | "caught_up" | "stalled";

export interface ChainHealth {
  level: HealthLevel;        // drives RecentBlocksTable banner (existing)
  reason: string;            // banner copy
  stage: SyncStage;          // drives SyncIndicator pill
  detail: string | null;     // pill sub-detail ("14 blocks behind", "7m", …)
  blockAgeMs: number | null;
  tipLagBlocks: number | null;   // renamed from indexerLagBlocks
}
```

`computeChainHealth` derives `stage` (and the paired `level` for the banner) in this precedence:

| # | Condition | `stage` | `level` | Banner |
|---|---|---|---|---|
| 1 | `indexer === null` | `connecting` | `healthy` | suppressed |
| 2 | `nowMs − lastStatusFetchAt ≥ 5 min` | `stalled` | `stalled` | red banner |
| 3 | `tipEpoch !== nodeLatestEpoch` OR `tipBlockIndex < nodeLatestBlockIndex` | `synchronizing` | `warning` | yellow banner with same copy as today's "different epoch" message, relabelled |
| 4 | `backfillEpoch !== null` | `backfilling` | `healthy` | suppressed |
| 5 | (otherwise) | `caught_up` | `healthy` | suppressed |

Existing precedence comments in `staleness.ts:82-84` (dead indexer masquerading as caught-up) are preserved — the heartbeat-stale check at row 2 must precede the same-cursor-as-node check that was at `staleness.ts:72`, or a wedged indexer would look caught-up.

## Workflows

### Tip worker loop

```
loop forever:
  statusRes ← tipClient.getStatus(null)
  if no body: writeObservability; sleep pollIntervalSec; continue

  status ← statusRes.body
  updateStallTracker(state, status, nowMs)
  maybeWarnStalled(state, config, nowMs)

  epochsBody ← tipClient.getEpochs()            # ETagged, usually 304
  replaceEpochStatus(epochsBody.epochs)          # live / stale_fork labels

  ownedStart ← computeTipOwnedStart(status.latestEpoch, epochsBody, chainAnchors)
  if state.tipCursor.epoch !== status.latestEpoch:
    state.tipCursor = { epoch: status.latestEpoch, blockIndex: ownedStart − 1 }

  while state.tipCursor.blockIndex < status.latestBlockIndex:
    idx ← state.tipCursor.blockIndex + 1
    raw ← tipClient.getBlock(status.latestEpoch, idx)
    if raw is null: warn-404; state.tipCursor.blockIndex = idx; continue
    insertBlock(raw); state.tipCursor.blockIndex = idx
    state.observability.lastBlockInsertAt = now()

  if nowMs − lastNodesFetchMs ≥ nodesRefreshSec * 1000:
    refreshNodesSnapshot(); refreshSelfAddress(); lastNodesFetchMs = nowMs

  writeObservability(); state.save()
  sleep pollIntervalSec
```

`computeTipOwnedStart` reuses the per-chain `lastBlock` arithmetic from `buildCanonicalPlan`, scoped to a single epoch: previous epoch on the same chain's `lastBlock + 1`, or `1` when no prior epoch is known. Nodes snapshot refresh and self-address resolution move verbatim from the existing `runIterationBody`.

### Backfill worker loop

```
loop forever:
  if plan cache is stale or empty:
    status ← backfillClient.getStatus(null)
    epochsBody ← backfillClient.getEpochs()
    fullPlan ← buildCanonicalPlan(backfillClient, state, status, epochsBody)
    plan ← reorderCanonicalFirst(fullPlan).filter(e → e.epoch !== status.latestEpoch)
    markPlanEntriesDone()                        # one SELECT MAX(blockIndex) per chain

  nextEntry ← plan.find(e → not e.done)
  if nextEntry is null:
    state.backfillCursor = { epoch: null, blockIndex: 0 }
    writeObservability(); state.save()
    sleep backfillIdleRecheckSec                 # 5 min default
    invalidate plan cache; continue

  if state.backfillCursor.epoch !== nextEntry.epoch:
    state.backfillCursor = { epoch: nextEntry.epoch, blockIndex: nextEntry.ownedStart − 1 }

  while state.backfillCursor.blockIndex < nextEntry.ownedEnd:
    idx ← state.backfillCursor.blockIndex + 1
    raw ← backfillClient.getBlock(nextEntry.epoch, idx)
    if raw is null: warn-404; state.backfillCursor.blockIndex = idx; continue
    insertBlock(raw); state.backfillCursor.blockIndex = idx
    state.observability.lastBlockInsertAt = now()

  mark nextEntry done; writeObservability(); state.save()
  # loop iterates immediately to pick up the next plan entry
```

`reorderCanonicalFirst(fullPlan)` partitions plan entries by whether their `chainAnchor` matches the anchor of `status.latestEpoch`. Canonical-chain entries come first, dead-fork entries after. Within each partition the existing `ownedStart` ordering is preserved.

Plan cache invalidation triggers: idle-recheck wake, chain-switch detection (`backfillCursor.epoch` vanished from plan on rebuild), and end of each full walk. Otherwise the cache is rebuilt every few iterations so new dead forks surface promptly.

Between individual block fetches the loop `await`s naturally, letting the tip worker interleave. No explicit yield points are needed.

### Startup sequence — `indexer/main.ts`

```
parse config; open DB; load state.json (wipe if version mismatch)
tipClient      ← new QuipClient(config)
backfillClient ← new QuipClient(config)
ac ← new AbortController

await Promise.all([
  runTipLoop({ config, client: tipClient, db, state }, ac.signal),
  runBackfillLoop({ config, client: backfillClient, db, state }, ac.signal),
])

# either worker throwing AuthError → ac.abort(); db.disconnect(); exit(1)
# --once mode: both workers run one iteration and return → exit(0)
```

Existing `SIGINT` / `SIGTERM` handlers call `ac.abort()`; both worker loops observe the signal at their next `await sleep` or `await client.*` and exit cleanly.

## UI

### New component — `src/components/layout/SyncIndicator.tsx`

Reads `indexer` and `latestBlockTimestampMs` from the telemetry store, calls `computeChainHealth` in a `useMemo`, and renders a pill keyed off `health.stage`:

| Stage | Dot | Color | Animation | Copy |
|---|---|---|---|---|
| connecting | 10px ring | gray `#A9A9A9` | spin | "Connecting to node…" |
| synchronizing (same epoch) | 7px dot | cyan `#4CE0FF` | pulse | "Synchronizing · N blocks behind" (N = `nodeLatestBlockIndex − tipBlockIndex`) |
| synchronizing (new epoch) | 7px dot | cyan `#4CE0FF` | pulse | "Catching up to new epoch" |
| backfilling | 7px dot | amber `#F5A623` | pulse (slower) | "Backfilling history" |
| caught_up | 7px dot | green `#67E347` | static | "Live" |
| stalled | 7px dot | red `#E34735` | static | "Indexer offline · Xm" (X = minutes since `lastStatusFetchAt`) |

Green matches the existing `#67E347` used for the "Network" view toggle. Cyan matches the existing `#4CE0FF` used for "By Type". Amber and red are new palette entries reserved for indexer state.

Pill layout is `inline-flex gap-2 items-center` so width tracks the detail text; stable across state transitions of similar length and reflows gracefully on narrow screens (consistent with `db668d4 fix(header): prevent epoch selector overlap on narrow screens`).

### `src/components/layout/Header.tsx` — layout B

Left grid cell becomes a vertical stack:

```tsx
<div className="flex flex-col items-center gap-2 justify-self-center sm:items-start sm:justify-self-start">
  <SyncIndicator />
  {showAggregation && <AggregationToggle />}
</div>
```

`SyncIndicator` renders in every view. The aggregation toggle continues to show only in `network` and `compute` views. When both are visible they stack vertically; when only the indicator is visible it sits alone left-aligned.

### `src/components/views/Network/RecentBlocksTable.tsx`

No structural change. The banner continues to read `health.level` and `health.reason` from `computeChainHealth`. Indicator and banner echo each other because both derive from the same source. Only type-rename knock-on needed (`cursorEpoch` → `tipEpoch`).

### `src/components/layout/EpochSelector.tsx`

No code change. The `(live)` label condition at `EpochSelector.tsx:36` resolves automatically once the tip worker indexes one block in the node's `latestEpoch`.

### `src/store/telemetry-store.ts`

Type updates only. No new store state.

## Error handling

| Scenario | Handling |
|---|---|
| `AuthError` from either worker | Worker logs, calls `ac.abort()`. `main.ts` awaits both loops, runs `db.disconnect()`, exits(1). |
| `RateLimitError` (429) | Worker-local exponential backoff (5s → 60s cap), persists state, retries. **Other worker unaffected** — the key improvement over today's shared backoff. |
| `insertBlock` throws | Log, save state, rethrow → worker's top-level catch logs + restarts after a short delay. Block stays un-indexed; next iteration retries. |
| Block fetch returns 404 / null | Log warn, advance cursor past the missing block. Unchanged from `loop.ts:276-281`. |
| Chain-switch mid-walk (cursor epoch vanished from plan) | Existing `loop.ts:229-242` reset-to-plan[0]; reused for `backfillCursor`. Tip worker handles via the epoch-change branch in its own loop. |
| Workers race on same `(epoch, blockIndex)` | DB idempotent insert resolves. No explicit coordination. |
| Unexpected exception in a worker | Top-level catch: log with stack, sleep pollInterval, restart own loop. Does not propagate to the other worker. |
| Observability write fails | Log warn, continue. Next poll's write overwrites. Matches existing best-effort pattern at `loop.ts:125-127`. |

## Testing

- **`indexer/tip-worker.test.ts`** (new) — fresh boot seeds `tipCursor` from ownedStart; epoch rollover resets `tipCursor`; same-epoch advance walks the range; unchanged `/status` writes heartbeat without fetching blocks; stall tracker fires on unchanged tip. Reuses the `FakeDb` / `FakeClient` harness from existing `indexer/loop.test.ts`.
- **`indexer/backfill-worker.test.ts`** (new) — plan orders canonical-chain-first; tip epoch filtered out; idle-recheck interval triggers rebuild; plan cache invalidates on chain-switch; `markPlanEntriesDone` skips fully-indexed epochs without HTTP.
- **`indexer/main.test.ts`** (new, minimal) — two workers start in parallel; `AuthError` in one aborts the other; SIGINT stops both.
- **`indexer/loop.test.ts`** (existing) — splits content between the two new files above. Shared helpers that apply to both workers stay in a new `indexer/shared.test.ts` if needed.
- **`src/lib/staleness.test.ts`** — every `obs()` helper updates to `tipEpoch` / `tipBlockIndex`; new tests per stage transition (connecting → synchronizing → backfilling → caught_up) and for the `detail` string content.
- **`src/components/layout/SyncIndicator.test.tsx`** (new) — renders the correct pill for each of the five stages; memoized clock does not re-render on unchanged state.
- **`src/components/views/Network/RecentBlocksTable.test.tsx`** — field-rename updates; banner copy assertions match renamed `reason` strings.
- **`server/app.test.ts`** — already uses `nodeLatestEpoch`; rename `cursorEpoch` → `tipEpoch`, add `backfillEpoch`.
- **`api/db/sqlite.test.ts`** + **`api/db/postgres.test.ts`** — observability round-trip asserts the new shape. No schema-migration test (no `SCHEMA_VERSION` bump).

All tests run under the existing `bun test` setup. No new test frameworks or infrastructure.

## Configuration

One new config knob:

- `BACKFILL_IDLE_RECHECK_SEC` (env var; default `300`) — interval the backfill worker sleeps between rebuilding the plan when it has no outstanding work. Guards against a previously-tip chain that became a dead fork mid-walk without fully indexing.

No changes to existing knobs (`POLL_INTERVAL_SEC`, `NODES_REFRESH_SEC`, `STALL_WARN_AFTER_SEC`, `BACKFILL_FROM_EPOCH`).

## Rollout

1. Deploy merges both workers in one release. No feature flag — the new architecture is strictly better than the old one and replaces it.
2. On first boot after deploy, the existing `state.json` is wiped (version-mismatch path) and both workers seed fresh. Tip worker catches up to the node's current epoch within one poll. Backfill worker begins walking the live chain's prior epochs.
3. The UI reads an old-shape observability blob for a few seconds post-deploy (until the tip worker writes the new shape). During that window the indicator shows "Connecting…" and the warning banner is suppressed — acceptable.
4. No DB schema migration. Existing blocks, epoch_status, nodes_snapshot rows remain.

## Open questions

None. All design decisions are resolved.

## References

- `indexer/loop.ts` — existing single-loop implementation to be split.
- `indexer/state.ts` — existing persistent state; `cursor` becomes `tipCursor + backfillCursor`.
- `src/lib/staleness.ts` — existing derivation logic; grows `stage` + `detail` fields.
- `src/components/layout/Header.tsx` — layout B modification.
- `src/components/layout/EpochSelector.tsx:36` — the condition whose natural resolution fixes the original bug symptom.
- Commit `db668d4` — narrow-screen responsive patterns to follow for the new pill.
- Commit `036fefb` — prior SCHEMA_VERSION bump; we explicitly do not repeat one.
