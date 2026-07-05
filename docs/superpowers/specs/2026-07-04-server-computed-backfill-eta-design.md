# Server-Computed Backfill ETA — Design

**Date:** 2026-07-04
**Status:** Approved (design)
**Supersedes:** the client-side ETA sampling added in the indexer-progress feature
(`lib/indexer-eta` `pushSample`/`estimateEtaMs`).

## Motivation

The indexing line's ETA is currently derived on the client by sampling the
remaining deficit over a rolling 90s window. That means: no ETA for ~90s after
every page load, the buffer resets on refresh, and the sample resolution is the
frontend's 15s poll. The indexer sees every reconcile tick (~6s, per head) and
runs continuously, so it can compute a smoother rate and expose a ready-to-use
ETA that appears instantly for any client and survives refreshes.

## Approach

The indexer computes `backfillEtaSeconds` in its reconcile producer and publishes
it in the backfill-progress observability. The frontend drops all client-side
sampling and simply formats the published seconds.

```
ReconcileProducer.publishProgress()   (every ~6s, per head — producers.ts:533)
  → estimateEtaSeconds(rolling (atMs,totalGaps) window)
  → state.observability.indexer.backfillEtaSeconds
  → meta.indexer_observability (persisted)
  → parseIndexerProgress  (whitelist — packages/core/api/db/adapter.ts)
  → server /api/telemetry
  → frontend: formatEta(backfillEtaSeconds * 1000)
```

## Server computation (indexer)

**Pure helper** `apps/indexer/pipeline/backfill-eta.ts`:

```ts
export interface EtaSample { atMs: number; remaining: number }
export function pushEtaSample(samples, next, windowMs?): EtaSample[]
export function estimateEtaSeconds(samples, minSpanMs?): number | null
```

- `pushEtaSample` appends `next` and trims to a trailing window (default 120_000
  ms), ignoring a sample whose timestamp did not advance, capped at a max count.
- `estimateEtaSeconds` returns `round(remaining / (netDecline / spanMs) / 1000)`
  when the window spans ≥ `minSpanMs` (default 90_000) **and** the deficit is net
  shrinking (`first.remaining − last.remaining > 0`); otherwise `null`.
- This is the exact windowed-net-decline logic already proven against the live
  chain (client version returned ~55m–1h10m from real samples), moved server-side
  and returning seconds instead of ms.

**Wiring in `ReconcileProducer.publishProgress()`** (`producers.ts:533-561`):

- Add an instance field `private etaSamples: EtaSample[] = []`.
- Compute `totalGaps = Σ coverage[plugin].gapBlocks` (already summed for the
  coverage object being built).
- `this.etaSamples = pushEtaSample(this.etaSamples, { atMs: this.deps.now(), remaining: totalGaps })`.
  Use the producer's existing clock dependency (`deps.now`), not `Date.now()`.
- Set `backfillEtaSeconds: estimateEtaSeconds(this.etaSamples)` on the published
  `observability.indexer` object.

The buffer is in-memory: after an indexer restart the ETA is `null` for ~90s
until the window refills. Acceptable — restarts are rare relative to client loads.

## Shared type + parser

**`packages/shared/telemetry/response.ts`** — `IndexerBackfillProgress` gains:

```ts
// Server-computed seconds until backfill catches up, or null when there isn't
// enough history yet or the deficit isn't net-shrinking. Optional-valued so
// pre-field persisted rows / a just-restarted indexer parse cleanly.
backfillEtaSeconds: number | null;
```

**`packages/core/api/db/adapter.ts`** — `parseIndexerProgress` carries it,
defaulting to `null` when absent:

```ts
backfillEtaSeconds:
  typeof p.backfillEtaSeconds === "number" ? p.backfillEtaSeconds : null,
```

A **DB round-trip test** asserts a written `backfillEtaSeconds` survives
persist → parse (the observability-whitelist gotcha: new fields are silently
stripped unless added here).

## Frontend (replace, don't deprecate)

- **Delete** `apps/frontend/src/lib/indexer-eta.ts`'s sampling API — `EtaSample`,
  `pushSample`, `estimateEtaMs`, and the `ETA_*` window constants — and their
  tests. **Keep** `formatEta` (move it to the top of `indexer-eta.ts` or inline
  in the component; it stays the single ms→label formatter).
- **`IndexerProgress.tsx`**: remove `useRef`, the sample accumulation, and the
  reset branch. Read `indexer.indexer?.backfillEtaSeconds`; when the stage is
  `indexing` and it is a positive number, append ` · ${formatEta(sec * 1000)}`.
  Node-sync stage carries no ETA (unchanged).
- The `computeIndexerProgress` helper (stage/deficit logic) is unchanged.

## Testing

- `backfill-eta.test.ts` (indexer): port the estimateEta unit tests — <2 samples
  → null; span < min → null; shrinking → correct seconds; grew/flat → null;
  `pushEtaSample` append/dedup/trim.
- Producer test: feed successive `publishProgress` ticks with a shrinking
  `totalGaps` over ≥90s (using the injectable clock) and assert
  `observability.indexer.backfillEtaSeconds` becomes a positive number; a growing
  deficit keeps it `null`.
- Parser round-trip test (core): `backfillEtaSeconds` persists and parses; absent
  → `null`.
- Frontend component test: set `backfillEtaSeconds` on the store fixture, assert
  `Indexing · … · ~13m`; absent/null → no suffix. `formatEta` unit tests stay.

## Non-goals

- No persistence of the ETA sample buffer across indexer restarts.
- No published rate field (only the ETA seconds, per design decision).
- No change to the gapBlocks metric, the node-sync stage, or the header placement.
- No smoothing beyond the windowed net-decline (no EMA/Kalman).
