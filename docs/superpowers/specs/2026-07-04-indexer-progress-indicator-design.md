# Indexer Progress Indicator — Design

**Date:** 2026-07-04
**Status:** Approved (design)
**Scope:** Frontend-only. No backend, DB, parser, or shared-type changes.

## Motivation

When the dashboard dev stack (or any fresh deployment) starts against a chain
that is ahead of the indexer, views that depend on backfilled data appear empty
for minutes with no explanation (e.g. the Compute Available hardware breakdown
stayed empty for ~8 minutes while the indexer backfilled ~4100 blocks and the
validator sync-gate flapped). Operators have no visible signal that the indexer
is *working and catching up* versus *broken*.

This feature adds a small, self-contained progress line under the **Connected
Miner** identity block in the header showing how far along synchronization is.

## User-visible behavior

A single line rendered directly beneath the connected miner's address
(`Header.tsx`, right column). It has three states:

| State         | When                                                       | Renders                        |
| ------------- | ---------------------------------------------------------- | ------------------------------ |
| **Node sync** | validator is syncing and `current < highest`               | `Node sync · 559,624 / 559,745` |
| **Indexing**  | not node-syncing, backfill meaningfully incomplete         | `Indexing · 555,600 / 559,745` |
| **Live**      | node synced **and** backfill drained                       | *(renders nothing)*            |

The line is also hidden (renders nothing) when observability is absent or stale
— the existing `SyncIndicator` already owns the "Indexer offline" messaging, so
this line does not duplicate offline/stale states.

Numbers are formatted with `toLocaleString("en-US")` (thousands separators),
matching the existing `SyncIndicator` progress format.

Flicker on a flapping local validator is acceptable (per design review): the
line may bounce between "Node sync" and "Indexing" every few seconds; no
debounce is added.

## Data source

All fields already reach the frontend store (`s.indexer`, typed
`IndexerObservability | null`) via `parseIndexerObservability` — verified
present and parsed:

- `nodeSyncing?: boolean` — sync-gate state (hysteresis already applied server-side).
- `nodeSyncCurrentBlock?: string | null`, `nodeSyncHighestBlock?: string | null` — validator sync progress (u64 as string).
- `chainHeadFromNode: string | null` — chain tip height (u64 as string).
- `indexer?.backfillQueueDepth: number` — scheduler queue depth (tip bucket + both backfill lanes).

No new fields, no server/parser/schema work.

## State machine (pure helper)

`computeIndexerProgress(indexer: IndexerObservability | null, nowMs: number)`
returns `IndexerProgress | null`:

```ts
type IndexerProgress =
  | { stage: "node-sync"; current: number; total: number }
  | { stage: "indexing"; current: number; total: number };
// null  => render nothing (live, absent, or stale)
```

Decision order:

1. **Absent / stale guard.** If `indexer === null`, return null. If the
   observability is stale (same freshness check the `SyncIndicator` uses via
   `lib/staleness`, anchored on `nowMs` vs `lastStatusFetchAt`), return null.
2. **Node sync.** If `indexer.nodeSyncing === true` and both
   `nodeSyncCurrentBlock` and `nodeSyncHighestBlock` parse to numbers with
   `current < highest`, return `{ stage: "node-sync", current, total: highest }`.
3. **Indexing.** Else, if `indexer.indexer` is present and
   `backfillQueueDepth > LIVE_THRESHOLD` and `chainHeadFromNode` parses:
   return `{ stage: "indexing", current: chainHead - backfillQueueDepth, total: chainHead }`.
   Clamp `current` to `[0, total]` for safety against transient overshoot.
4. **Live / unknown.** Otherwise return null (render nothing).

### `LIVE_THRESHOLD`

`backfillQueueDepth` briefly ticks to ~1 on each new live block (the tip
bucket), so a strict `> 0` test would keep the indicator visible during normal
live operation and never reach the "Live" (hidden) state. `LIVE_THRESHOLD` is a
small constant (default `2`) below which the queue is treated as routine live
tip churn, not catch-up. Documented as a named constant with this rationale.

### Indexing metric rationale (approach A)

`total = chainHeadFromNode`, `current = chainHeadFromNode − backfillQueueDepth`.
Chosen over coverage-span math because: it is always well-defined; it uses the
reconciler's own single source of truth for remaining work; it reaches
`current === total` exactly when caught up; and it avoids the gappy,
multi-plugin coverage aggregation. This is an approximation of "blocks
processed," not a literal contiguous height — acceptable for a progress hint.

## Files

**Create**

- `apps/frontend/src/lib/indexer-progress.ts` — pure `computeIndexerProgress`
  helper + `IndexerProgress` type + `LIVE_THRESHOLD`. No React, no store access.
- `apps/frontend/src/lib/indexer-progress.test.ts` — unit tests.
- `apps/frontend/src/components/layout/IndexerProgress.tsx` — presentational
  component: reads `s.indexer` and server-anchored `nowMs` from the telemetry
  store, calls the helper, renders the line or `null`.

**Modify**

- `apps/frontend/src/components/layout/Header.tsx` — render `<IndexerProgress />`
  inside the Connected Miner block, beneath the address `<p>` (lines ~130-131).
  Only mounted when `selfAddress` is set (same block); the component itself
  further returns null per the state machine.

## Rendering details

- Reuse the header's existing typography for secondary text (`font-accent`,
  `text-[10px]`/`text-xs`, `text-ink-subtle`), consistent with the "Connected
  Miner" label and address.
- `role="status"` + `aria-live="polite"` so screen readers announce progress
  transitions, matching `SyncIndicator`.
- Label copy: `Node sync` for stage `node-sync`, `Indexing` for stage
  `indexing`, joined to `{current} / {total}` with a middle dot `·`.

## Testing

Unit tests for `computeIndexerProgress` (mirroring `staleness.test.ts` style):

- `indexer === null` → null.
- Stale observability (old `lastStatusFetchAt` vs `nowMs`) → null.
- Node syncing, `current < highest` → `node-sync` with correct numbers.
- Node syncing but `current >= highest` → falls through (not node-sync).
- Not syncing, `backfillQueueDepth` large → `indexing` with
  `current = chainHead − depth`, `total = chainHead`.
- `backfillQueueDepth <= LIVE_THRESHOLD` → null (live).
- Missing `nodeSyncCurrentBlock`/`Highest` while `nodeSyncing` true → falls
  through to indexing/live rather than throwing.
- Missing `chainHeadFromNode` in indexing branch → null.
- `current` clamp: `backfillQueueDepth > chainHead` → `current` clamped to 0.

Component render is exercised lightly (renders expected text for each stage,
renders nothing for null) if it fits the existing component-test pattern;
otherwise the pure helper carries the coverage.

## Non-goals (YAGNI)

- No progress bar / percentage / ETA — a single text line only.
- No debounce/hysteresis beyond what the server-side sync-gate already applies.
- No per-plugin (winners/difficulty/authorship) breakdown.
- No backend, parser, or shared-type changes.
- No changes to `SyncIndicator` or `CurrentBlockIndicator`.
