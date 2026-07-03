# Indexer Redesign: Work-Queue Unified Indexer ("blockq")

Date: 2026-07-02
Status: Approved design, ready for implementation
Branch target: `v0.2`

## 1. Summary & goals

One indexer process computes both real-time data and historical backfill (R1). The redesign
replaces today's three ad-hoc chain streams (`BlockPipeline`, `Backfill`, `PollScheduler`) and the
separate `DescriptorWorker` with three isolated layers (R2):

- **L1 — block scheduler**: a prioritized work queue that knows, per indexable, where it started
  and where it left off (persistent coverage cursors in the `meta` KV table), backfills gaps, and
  always services chain-tip events before backfill. Backfill runs in two lanes — winner
  enumeration (lane W) ahead of the dense walk (lane D), each with its own rate allowance — so
  winner-domain history completes in minutes while the dense walk takes days (§5, §13).
- **L2 — block index engine**: given one block, fetch its data once and run every registered
  per-element handler against it, with per-handler error isolation.
- **L3 — per-element handlers**: one plugin per indexed data element. Adding an indexable that
  consumes the existing `BlockContext` reads is one file plus one registry entry; a new chain
  read additionally extends `BlockContext` (§4).

Reconciliation runs on boot and every 15 minutes thereafter; each indexable fills its own gaps
independently (R3). A `--reindex[=name,…|all]` mode drops an indexable's rows and cursor and
re-walks from its start block (R4; for winner-domain plugins "start" means the earliest block
the `qBlocks` map reaches — measured in step 0, §15). Pruned validator state degrades per
accessor and reports the reached depth instead of crashing (R5). The redesign ships in one pass
with an ordered implementation plan and verification gates (R6). Existing idioms are preserved:
ports/ISP role interfaces, RxJS `ConnectionStream` composition, idempotent DB writes, monotonic
cursors in the `meta` KV table, and the fatal-vs-non-fatal worker split (R7).

The immediate downstream driver is deep difficulty history for the price-panel range selector
(1h/6h/12h/24h/7d/1m/YTD/All Time). Difficulty history is derived from indexed winner blocks —
this avoids per-block historical `Difficulty` storage reads, though each winner block still
needs per-block historical state (timestamp, events, author; §8), so under pruning it floors at
the same depth as every other block read. It is served by the already-implemented
`getDifficultySince` (`packages/core/api/db/adapter.ts:247`) plus a window-anchor row (§10.5)
(R8).

**Non-goals**

- No changes to the miner-local tip pipeline's driver: `TipWorker` (`apps/indexer/tip/worker.ts`)
  polls the miner REST API, not the chain, and stays the sole fatal worker
  (`apps/indexer/main.ts:186-197`). It gains a descriptor-only registry entry for visibility
  (§4.1) but is not rescheduled.
- No changes to `/api/telemetry` payload shapes beyond one additive field (R10). One existing
  parser (`parseIndexerObservability`) is extended to pass the additive field through (§11).
- No multi-process sharding, no external queue service, no new database. The queue is in-process;
  cursors live in the existing `meta` table.
- No "drop rows but keep cursor" mode, no per-plugin rate limits, no admin API. Demand-driven:
  add them when someone needs them.
- The qblock-only pruned-depth fallback for winner-domain plugins (§8) is designed but
  deferred — it is documented so a later pass can pick it up; nothing in this pass builds it.
- `reconstruct-firstseen.ts` is kept unchanged. It is a standalone archive-node maintenance
  command for descriptor `firstSeen` recovery (`apps/indexer/reconstruct-firstseen.ts:1-14`);
  nothing in this design replaces that function.

## 2. Current state

- `apps/indexer/main.ts:186-220` runs three `WorkerSpec`s: `tip` (fatal), `substrate`
  (non-fatal), `descriptor` (non-fatal). Only a fatal worker's failure aborts the process
  (`WorkerSpec.fatal`, `apps/indexer/main.ts:17-24`; `runWorkers`' `if (spec.fatal) ac.abort()`,
  `main.ts:50`).
- `SubstrateWorker.run` (`apps/indexer/substrate/worker.ts:65-116`) is the connect/reconnect/
  shutdown loop: `defer(connect)` → `retry` with URL rotation and backoff → `takeUntil(abort)`.
  `connection()` (`worker.ts:120-143`) is the per-connection composition root: it merges three
  `ConnectionStream`s — `ChainHeadWriter`, `BlockPipeline`, `PollScheduler` — plus
  `fromDisconnect(client)`. `retry({delay})` intercepts errors only; a stream that completes
  cleanly completes `run()` (`worker.ts:88-116`) — the `--once` exit path (§7) leans on this.
- `BlockPipeline` (`apps/indexer/substrate/blocks.ts`) handles live finalized heads: authorship →
  winner filter → enrich (`getLastProofBlockAt`, `getQBlock`, `blocks.ts:88-94`) → a difficulty
  `scan` that threads the prior block's difficulty for pre-v0.2 blocks (`blocks.ts:104-107`) →
  `insertBlock`, stamping `topologyHash` from live `state.defaultTopologyHash` (`blocks.ts:181`).
- `Backfill` (`apps/indexer/substrate/backfill.ts:19-45`) diffs `getQBlockNumbers()` against
  `getExistingBlockNumbers()` on each connect and inserts missing winner blocks. It has no cursor;
  it recomputes the full diff every reconnect. `getQBlockNumbers()` calls
  `api.query.quantumPow.qBlocks.entries()` (`clients/substrate-client/index.ts:530`) — it fetches
  every key **and** every `WinningSolution` value, then discards the values.
- `backfill-topology.ts` is a one-shot topology-tag backfill launched from `main.ts:180-182`,
  stamping only current-topology blocks (`backfill-topology.ts:3-15`).
- `PollScheduler` (`apps/indexer/substrate/polls.ts:43-52`) runs `timer(0, period)` →
  `exhaustMap(runEffect(...))` polls: babe epoch, current difficulty (`polls.ts:81-91`), and chain
  state (miners + mineable topologies, publishing `state.defaultTopologyHash` at `polls.ts:173`).
- `DescriptorWorker` scans registry descriptors on a `timer(0, interval)` → `exhaustMap` cadence
  (`apps/indexer/descriptor/worker.ts:159-160`) with a monotonic meta checkpoint
  (`DESCRIPTOR_CHECKPOINT_KEY`, `packages/core/api/db/kysely-adapter.ts:698-702`).
- **Known idempotency break**: `recordValidatorAuthorship` is an increment —
  `blocks_authored + 1` (`kysely-adapter.ts:588-608`) — with dedup pushed to the caller
  (`adapter.ts:280-293`), which `blocks.ts:143` implements only per connection. Any replay
  double-counts.
- `difficulty_history` already has `observed_at_block numeric` as its primary key
  (`packages/core/migrations/0001_initial.ts:117-119`), and `insertDifficultySnapshot` already
  conflicts on it with do-nothing (`kysely-adapter.ts:491-503`). `getDifficultySince(sinceIso)`
  exists and is tested (`kysely-adapter.ts:516-524`, `adapter.ts:247`).
- Cursors and snapshots live in the `meta` KV table (`0001_initial.ts:57`), written via
  `setMeta` / `setMetaMonotonic` (`kysely-adapter.ts:805-825`).
- The server reads indexer observability from meta and embeds it in `/api/telemetry`
  (`apps/server/routes/telemetry.ts:60,88`; type at `packages/shared/telemetry/response.ts:32`).
  The raw meta payload is whitelist-reconstructed by `parseIndexerObservability`
  (`packages/core/api/db/adapter.ts:32-64`) — unknown fields are dropped on read.
- `config.once` is today consumed only by `TipWorker` (`tip/worker.ts:53-56` — one iteration,
  then complete); `SubstrateWorker` ignores it.

Scale today: ~527k substrate blocks, ~3.8k winner blocks. Average win interval:
527k blocks × 6s ÷ 3.8k winners ≈ 832s ≈ **~14 minutes**.

## 3. Architecture overview

New directory `apps/indexer/pipeline/`:

| file | contents |
|---|---|
| `coverage.ts` | pure interval algebra: coverage value type, union/subtract, item- and range-completion folds, invariants |
| `plugin.ts` | L3 interfaces **including `BlockContext`**, `buildRegistry(cfg)` |
| `queue.ts` | `QueueCore` — pure, clock-injected priority queue (tip bucket + two backfill lanes) |
| `producers.ts` | `TipEnqueuer`, `BackfillWalker`, `Reconciler` (L1 `ConnectionStream`s) |
| `dispatch.ts` | queue driver + `DispatcherStream`, coverage flusher (L2); imports `BlockContext` from `plugin.ts` |
| `snapshots.ts` | snapshot scheduler `ConnectionStream` (generalizes `PollScheduler`) |
| `plugins/*.ts` | one file per indexable (L3) |

Deleted: `substrate/backfill.ts` (logic absorbed into the reconciler cross-check),
`substrate/backfill-topology.ts` (replaced by per-block topology stamping in the `winners`
plugin), `substrate/blocks.ts` (body moves into `plugins/winners.ts` + `plugins/authorship.ts`),
`descriptor/worker.ts` (scan body moves into `plugins/node-descriptors.ts`; `descriptor/
iteration.ts` and `descriptor/reconstruct.ts` are kept as the logic modules they already are).

Kept: `core/{worker,rx,state,config,bounded-key-set}.ts`, `clients/substrate-client/`,
`substrate/{worker,chain-head,ports,shared,streams}.ts`, `tip/` (whole miner-local pipeline),
`reconstruct-firstseen.ts`.

`SubstrateWorker` itself is **not** replaced. Its `run()` loop — retry, URL rotation, backoff,
`takeUntil` (`worker.ts:65-116`) — is kept verbatim; the `ConnectionStream[]` built in
`connection()` (`worker.ts:120-143`) changes:

```
before: [ChainHeadWriter, BlockPipeline, PollScheduler]
after:  [ChainHeadWriter, TipEnqueuer, BackfillWalker, Reconciler, DispatcherStream, SnapshotScheduler]
```

One deliberate exception to "stream contents only": under `--once`, `connection()` additionally
pipes the merged streams through `takeUntil(done$)` (§7). This is a behavior change to
`connection()` beyond swapping the stream list and is stated as such. `run()` itself needs no
edit: `retry({delay})` intercepts errors only, so a cleanly completed connection stream already
completes `run()` (`worker.ts:88-116`). `main.ts` shrinks to two `WorkerSpec`s: `tip` (fatal)
and `substrate` (non-fatal, self-healing) — R1's one process, R7's fatal split preserved.

```
                    SubstrateWorker.run()  (unchanged retry/rotation loop;
                               │            clean completion is terminal → --once exit)
                               │ per connection
   ┌───────────────────────────┴──────────────────────────────────────────┐
   │ L1: scheduling                                                       │
   │  TipEnqueuer ──(finalized head n)───► ┌──────────────┐               │
   │  BackfillWalker ─ lane W (winners) ─► │  QueueCore   │ pull order:   │
   │                 └ lane D (dense)  ──► │  (pure)      │ tip, then     │
   │  Reconciler (boot + 900s) ───────────►│              │ lane W, then  │
   │   │ re-primes walker; emits done$     └──────┬───────┘ lane D        │
   │   │ under --once                             │ driver: wake Subject  │
   ├───┼──────────────────────────────────────────┼─+ timer retries──────┤
   │ L2: dispatch                                 ▼ tryPull(now)          │
   │  DispatcherStream: build BlockContext (1 block fetch, memoized       │
   │  reads) → tip items via concatMap / backfill via mergeMap(4) →       │
   │  per-plugin catch → buffered coverage flush (item completions +      │
   │  the walker's range-completion records, §5/§7)                       │
   ├──────────────────────────────────────────────────────────────────────┤
   │ L3: plugins (registry)                                               │
   │  block: winners │ difficulty │ authorship                            │
   │  snapshot: chain-state │ babe-epoch │ difficulty-current │           │
   │            node-descriptors          (SnapshotScheduler, timers)     │
   │  snapshot (descriptor-only): miner-local — driven by TipWorker §4.1  │
   └──────────────────────────────────────────────────────────────────────┘
        │ idempotent row writes                │ coverage JSON
        ▼                                      ▼
      blocks / difficulty_history /         meta KV: indexer.coverage.<name>,
      validator_authorship_blocks           indexer.generation.<name>
```

## 4. L3 — plugin interfaces & registry (`pipeline/plugin.ts`)

`BlockContext` lives here — it is part of the L3 contract (plugins consume it; `dispatch.ts`
imports it to construct it). This keeps implementation steps 2 and 4 self-contained (§15).

```ts
export type BlockDomain = "every-block" | "winner-blocks";

export interface BlockContext {
  readonly number: number;
  readonly source: "tip" | "backfill";
  readonly events: BlockEvents;                        // one processFinalizedBlock() call
  readonly qblock: () => Promise<QBlockInfo | null>;   // memoized
  readonly lastProofBlockAtParent: () => Promise<number>;   // memoized
  readonly defaultTopologyAt: () => Promise<string | null>; // memoized; §6, §8
  /** Current topology node/edge counts, primed once per connection with a
   *  {nodeCount: 0, edgeCount: 0} fallback — exactly today's prime()
   *  (blocks.ts:207-217). Feeds blocks.num_nodes / num_edges. */
  readonly topology: () => Promise<TopologyInfo>;
}

export interface BlockIndexable {
  readonly name: string;                    // meta-key suffix, --reindex target
  readonly kind: "block";
  readonly domain: BlockDomain;
  /** Genesis floor for this indexable (usually 0). Called once per connection. */
  startBlock(client: ChainClient): Promise<number>;
  /** MUST be idempotent: running twice for the same block leaves one row. */
  onBlock(ctx: BlockContext, db: DatabaseAdapter): Promise<void>;
  /** R4: delete this indexable's rows. Coverage/generation are handled by the runner. */
  dropState(db: DatabaseAdapter): Promise<void>;
}

export interface SnapshotIndexable {
  readonly name: string;
  readonly kind: "snapshot";                // R9: current-state, no history
  /** Which loop drives poll(). "scheduler" (default) = SnapshotScheduler timer;
   *  "tip-worker" = descriptor-only entry, driven by the fatal TipWorker (§4.1). */
  readonly driver?: "scheduler" | "tip-worker";
  intervalSec(cfg: IndexerConfig): number;
  poll(client: ChainClient, db: DatabaseAdapter, state: IndexerState): Promise<void>;
  dropState(db: DatabaseAdapter): Promise<void>;
}

export type Indexable = BlockIndexable | SnapshotIndexable;

export function buildRegistry(cfg: IndexerConfig): Indexable[];
```

**Pluggability, scoped honestly (R2/L3)**: adding an indexable that consumes the existing
`BlockContext` reads (or is a snapshot poller) is one file in `plugins/` plus one `buildRegistry`
entry — no scheduler, dispatcher, or queue edits. Adding a block indexable that needs a **new**
chain read is one file, one registry entry, **plus** extending `BlockContext` in `plugin.ts` and
its memoized construction in `dispatch.ts`. The scheduler and queue are still never edited. The
`kind` flag is the R9 distinction: block-scoped indexables are backfillable via the block walk;
snapshot indexables are poll-driven current-state writers registered in the same process.

### 4.1 Miner-local indexables (R9) and the fatal-worker tension

R9 lists self miner stats / heartbeat / submissions among the current-state indexables. They are
registered as **one descriptor-only snapshot entry**, `miner-local` (`kind: "snapshot"`,
`driver: "tip-worker"`), whose `poll` body delegates to the existing tip iteration. The
`SnapshotScheduler` skips `driver: "tip-worker"` entries; `TipWorker` keeps driving the same
iteration on its own timer. This makes the entry visible to `--list-indexables` and keeps the R9
taxonomy complete without changing who runs the code.

The tension this resolves: scheduling `miner-local` under the non-fatal `SnapshotScheduler`
would silently convert miner-REST failures from fatal to logged. An unreachable miner API is a
deploy/config error the operator must see immediately, which is exactly why `TipWorker` is the
sole fatal worker (R7, `main.ts:17-24,50`). So the registry entry is descriptive, the fatal
driver is unchanged, and this paragraph records the trade-off. `miner-local.dropState` is a
documented no-op — tip data re-accumulates from the live miner, and `resetMiningHistory`
(`adapter.ts:426`) remains the targeted maintenance primitive.

### Registry mapping (every existing indexable)

| plugin | kind / domain | ports logic from | notes |
|---|---|---|---|
| `winners` | block / winner-blocks | `blocks.ts` enrich + `insertBlock` (`blocks.ts:88-94,243-244`) | `topologyHash` from `ctx.defaultTopologyAt()` per block — replaces both `state.defaultTopologyHash` live stamping for backfill and the one-shot `backfill-topology.ts`; `num_nodes`/`num_edges` from `ctx.topology()`; pre-v0.2 difficulty triple = `ZERO_DIFFICULTY` (§10.2) |
| `difficulty` | block / winner-blocks | `blocks.ts` difficulty scan → row-per-winner-block | writes `difficulty_history` rows with `source = 'block'` (§9.3, §10) |
| `authorship` | block / every-block | `blocks.ts` authorship branch | row-per-(validator, block) insert into new table; §9 |
| `chain-state` | snapshot | `polls.ts` `pollChainState` (`polls.ts:109-150`) | miners + mineable topologies; MUST keep publishing `state.defaultTopologyHash` every poll (`polls.ts:173`) — `ctx.defaultTopologyAt()`'s tip fallback depends on it |
| `babe-epoch` | snapshot | `polls.ts` `pollBabeEpoch` (`polls.ts:55-59`) | unchanged body |
| `difficulty-current` | snapshot | `polls.ts` `pollDifficulty` (`polls.ts:81-91`) | keeps writing tip snapshots, now with `source = 'poll'`; coexists with the `difficulty` block plugin (§10.4); `dropState` is a documented no-op (§8) |
| `node-descriptors` | snapshot | `descriptor/iteration.ts` `scanHead` | keeps `DESCRIPTOR_CHECKPOINT_KEY` monotonic checkpoint (`kysely-adapter.ts:698-702`) |
| `miner-local` (self miner stats, heartbeat, submissions) | snapshot, driver `tip-worker` | `tip/` | descriptor-only entry; driven by the fatal `TipWorker` (§4.1) |

Existing `exhaustMap` cadences (`polls.ts:43-52`, `descriptor/worker.ts:159-160`) become each
snapshot plugin's `intervalSec`.

## 5. L1 — scheduler: queue, tip watcher, walker, reconciler

### Work items and QueueCore (`pipeline/queue.ts`)

```ts
type BackfillLane = "W" | "D";   // W = winner enumeration, D = dense walk

interface WorkItem {
  readonly block: number;
  source: "tip" | "backfill";    // promotion may upgrade backfill → tip (below)
  lane: BackfillLane | null;     // null for tip items
  /** Plugins that still need this block, pre-computed by the producer (never
   *  re-derived per plugin per block in the dispatcher). */
  pending: Set<string>;
}
```

`QueueCore` is a pure, synchronous class with an injected clock. Buckets and pull order:

- **tip bucket**: FIFO, always drained first — the tip bias is structural, not heuristic
  (R2/L1). Tip pulls are never rate-limited.
- **backfill heap**: min-heap keyed `(lane, -height)` — lane W items sort ahead of lane D
  items; within a lane, newest-first. Lane W (winner enumeration) feeds the winner-domain
  plugins; lane D (dense walk) feeds every-block plugins. Each lane has **its own token
  bucket**, default `backfillBlocksPerSec = 5` per lane (§13); when dispatcher concurrency is
  the binding constraint, the heap order means lane W claims capacity first.

Backfill pulls (both lanes) are additionally gated by a **tip-quiet gate**: no backfill pull
while `now − state.observability.lastSubstrateEventAt < 750ms` (field already maintained at
`worker.ts:131`, `chain-head.ts:34,42`). Queue priority orders our work; the quiet gate keeps
the shared websocket free at the instant a tip block arrives, bounding tip RPC latency under
saturated backfill.

**Dedup and promotion**: a `BoundedKeySet` (`apps/indexer/core/bounded-key-set.ts:12`) tracks
enqueued-or-inflight block numbers. Enqueueing a duplicate always unions its `pending` set into
the existing item; the bucket/lane of the merged item follows three promotion rules:

1. a **tip** enqueue of a block sitting in either backfill lane moves it to the tip bucket and
   its `source` becomes `"tip"` (so `defaultTopologyAt()` resolves live, §6);
2. a **lane-W** enqueue of a block sitting in lane D moves it to lane W (winner-domain work must
   not wait behind the dense token bucket);
3. reverse-direction duplicates (backfill enqueue of a tip item; lane-D enqueue of a lane-W
   item) are pure pending-unions — never a demotion.

Completion is tracked per block number, so an enumerated winner counts as done for the walker's
range tracking (below) no matter which bucket ultimately served it.

Backpressure: the walker is pull-driven — per lane, it computes the next chunk (64 block
numbers) only when that lane's `backfillDepth(lane) < 128`. Tip pushes are unconditional (≤1 per
~6s slot).

### Queue driver (the impure shell around the pure core)

`QueueCore.tryPull(nowMs)` returns one of: a `WorkItem`; `{retryAtMs}` (rate-limited or
tip-quiet — retry then); or `"empty"`. A thin driver observable in `dispatch.ts` wraps it so the
tested core is the shipped core:

```ts
const wake$ = new Subject<void>();        // producers: queue.enqueue(item); wake$.next()
const item$ = wake$.pipe(
  startWith(undefined),
  switchMap(() => drain()),               // pull until "empty", honoring retryAtMs
);
// drain(): tryPull(now) → WorkItem  → emit, pull again
//                       → {retryAtMs} → timer(retryAtMs − now), pull again
//                       → "empty"     → complete (sleep until next wake$)
const [tip$, backfill$] = partition(item$, (i) => i.source === "tip");
merge(
  tip$.pipe(concatMap(process)),                          // strict order at the tip
  backfill$.pipe(mergeMap(process, backfillConcurrency)), // = 4, order-free (§6)
);
```

Producers never block: they enqueue synchronously and signal `wake$`. All timing decisions
(token buckets, tip-quiet) live in the pure core; the driver only sleeps and retries when told.

### Producers (`pipeline/producers.ts`) — each a `ConnectionStream`

- **TipEnqueuer**: `fromChainSubscription(subscribeFinalizedHeads)`
  (`substrate/ports.ts:32`) → enqueue `{block: n, source: "tip", pending: allBlockPlugins}`.
  If `n − lastSeenHead ≤ 32`, enqueue the intervening blocks at tip priority too — covers short
  subscription blips without waiting for the next reconcile. The tip path enqueues numbers only;
  the dispatcher fetches block data uniformly for tip and backfill items (one code path; the
  extra `processFinalizedBlock` per ~6s tip block is negligible, §13). Tip enqueues promote
  overlapping backfill items per rule 1 above.
- **BackfillWalker**: on connect, receives per-plugin uncovered sets from the reconciler plus
  the reconciler's most recent winner-set enumeration (paged keys; see cross-check below), and
  walks two lanes newest-first, respecting each plugin's `prunedFloor`:
  - **Lane W** — ranges needed by winner-domain plugins: per 64-block chunk `[a, b]`, look up
    the enumerated winners inside `[a, b]` and enqueue only those numbers (lane W, winner-domain
    plugins pending). The walker keeps a per-chunk tracker; the dispatcher reports each item's
    per-plugin completion back to it. When every winner item in `[a, b]` has completed
    (successfully or not) for winner-domain plugin P, the walker hands the dispatcher a
    **range-completion record** `{plugin: P, range: [a, b]}`: enumeration proves the non-winner
    numbers in the range carry nothing for P, so the dispatcher flushes `[a, b]` as covered for
    P — minus any winner block whose `onBlock` threw for P, which stays in P's gap list (§6,
    §7). A chunk containing zero winners emits its range-completion immediately, with no queue
    round-trip. The dispatcher remains the single coverage writer; the walker only produces
    records.
  - **Lane D** — ranges needed by any every-block plugin: enqueue every number (lane D), with
    `pending` set to exactly the plugins whose coverage lacks that block. Where lanes overlap a
    block, dedup unions `pending` (promotion rule 2), so no block is fetched twice.
- **Reconciler**: `timer(0, reconcileIntervalSec)` (default 900s) →
  `exhaustMap(runEffect("reconcile", …))` (`core/rx.ts:45`), the same shape as today's polls
  (`polls.ts:43-52`). Each tick:

  1. fetches the **current finalized head via RPC** (one `chain.getFinalizedHead` +
     `getHeader` pair added to the ports interface) — never the persisted observability value,
     which is stale after downtime. `--once`'s exit condition checks against this fetched head.
  2. runs the pure **solver** per plugin:

     ```
     uncovered(plugin) = gaps ∪ (high, head] ∪ [max(start, prunedFloor), low)
     ```

     computed from the persisted coverage (§7), then primes the walker with the union. The
     leading tick is the boot backfill (R3); the periodic tick makes gap repair continuous.
     Boot backfill, periodic reconcile, and the post-`--reindex` walk are literally the same
     `solver(coverage, head, start)` call — one code path to reason about.

  **DB-truth cross-check** (coverage-ledger drift detector) — per block plugin, run at **boot
  and hourly** (not every 15-minute tick; the 15-minute tick runs only the pure solver):

  - **winners**: enumerate the winner set via **paged keys** (`qBlocks.keysPaged` — keys only;
    replaces today's `entries()` at `index.ts:530`, which fetches every `WinningSolution` value
    just to discard it; `getQBlockCount`'s fallback already uses `keys()` as precedent), then
    diff against `getExistingBlockNumbers()` (`adapter.ts:185`) — today's `Backfill.missing()`
    diff (`backfill.ts:36-39`). Missing winners are logged (`[indexer] coverage drift`) and
    re-enqueued (lane W) with `winners` pending.
  - **difficulty**: the same enumerated winner numbers, minus pre-v0.2 winners (which are
    deliberately skipped, §10.2 — comparing them would report permanent false drift), diffed
    against `SELECT observed_at_block FROM difficulty_history WHERE source = 'block'` via an
    indexed `IN` on the primary key. Missing rows re-enqueue with `difficulty` pending.
  - **authorship**: sample checks — 4 random covered chunks per run; for each,
    `count(*) WHERE block_number BETWEEN a AND b` (served by the `block_number` index, §9.1)
    against the chunk's block count. A short chunk is logged and re-enqueued (lane D,
    `authorship` pending) — re-processing 64 blocks is idempotent and cheap. A chunk that
    still falls short after one re-walk (possible only if a finalized block genuinely has no
    resolvable author) is logged `authorship chunk short (authorless blocks?)` and suppressed
    from further sampling for the current generation, so it cannot flap `--once` or spam logs.

  Coverage is the plan; rows are the truth; the diff reconciles them. **Cost**: the enumeration
  is O(total winner count) keys per run — ~4k keys (a few hundred KB of RPC payload) today,
  linear in winner growth (~10MB per run at 100k winners), at ~25 runs/day (boot + hourly).
  This scaling is why the 15-minute tick does not enumerate.

  Under `--once`, the deciding reconcile tick re-runs the full cross-check regardless of the
  hourly cadence, and emits `done$` when the §7 exit condition holds.

### RxJS composition

Unchanged from today at the worker level: `SubstrateWorker.run()` keeps its
`defer(connect)` → `merge(streams…, fromDisconnect(client))` → `retry`/rotation →
`takeUntil(fromAbortSignal)` loop (`worker.ts:65-143`). `QueueCore`, the driver, and the walker
are per-connection objects rebuilt from persisted coverage on reconnect — cheap, and safe
because every write is idempotent — so no scheduler state leaks across connections.

## 6. L2 — dispatch engine (`pipeline/dispatch.ts`)

The driver (§5) pulls items and partitions them: tip items flow through `concatMap` (strict
block order, matching today's live pipeline); backfill items flow through
`mergeMap(backfillConcurrency = 4)` — coverage-based completion is order-independent, so
unordered completion is safe. For each item the dispatcher builds one shared `BlockContext`
(interface defined in `plugin.ts`, §4) and fans out to `item.pending` plugins.

The block is fetched **once** per item (`processFinalizedBlock`,
`clients/substrate-client/index.ts:559-568`); plugins share memoized lazy reads, so N plugins
≠ N× RPC. `defaultTopologyAt()` resolves as: for `tip` items, live `state.defaultTopologyHash`
(exactly today's `blocks.ts:181`); for `backfill` items, `getDefaultTopologyAt(number)`
(`index.ts:786-810`), which returns the true historical value (also for prior-topology eras,
improving on migration 0004's current-era-only stamping), `null` when legitimately absent, and
surfaces `StatePrunedError` distinctly when the state is pruned (contract change, §8).
`topology()` is primed once per connection (§4).

**Error isolation**: each plugin's `onBlock` runs inside a `runEffect`-style catch. A throw
logs with the plugin name and block number, withholds coverage for that block **for that plugin
only** (it lands in the plugin's gap list at the next flush), and the sibling plugins still run
and advance. One handler never poisons its siblings; the reconciler retries the gap forever
(with the drift log making a permanently poisoned block visible to operators).

**Batching & crash safety**: row writes are per-block and idempotent (`insertBlock` conflicts on
`block_hash`, `kysely-adapter.ts:155`; difficulty conflicts on `observed_at_block`,
`kysely-adapter.ts:502`; authorship becomes an idempotent insert, §9). Coverage writes are
buffered: the dispatcher folds two record kinds into each plugin's pending coverage delta —
per-item completions and the walker's range-completion records (§5) — and flushes the coverage
JSON every 100 completed blocks or 5s, whichever first. Post-authorship-cutover, the same flush
transactionally recomputes the authorship summary cache (§9.2). A crash between a row write and
a coverage flush re-processes ≤100 blocks — harmless, because every write is genuinely
idempotent after §9 (this is the property the old authorship counter broke, which is why §9 is
a prerequisite, not an option).

## 7. Cursor & coverage model (`pipeline/coverage.ts`)

Per block plugin, two rows in the existing `meta` KV table (R7's cursor idiom; `getMeta`/
`setMeta` at `kysely-adapter.ts:796-811`):

- `indexer.generation.<name>` — integer, starts at `1`, bumped by `--reindex` (§8).
- `indexer.coverage.<name>` — JSON:

```json
{ "v": 1, "gen": 1, "start": 0, "low": 481203, "high": 527441,
  "gaps": [[490000, 490000]], "prunedFloor": null, "updatedAt": "2026-07-02T…" }
```

Covered set = `[low, high] \ gaps`. A block enters the covered set in exactly two ways, both
flushed by the dispatcher:

1. **item completion** — the plugin's `onBlock` ran successfully for that block;
2. **range completion** — for winner-domain plugins, the walker's range-completion record
   proves a chunk's non-winner numbers carry nothing for the plugin (§5). This is what makes
   winner-domain coverage converge to a contiguous `[start, head]` instead of a permanent
   ~523k-block gap set; without it the solver would re-report the non-winner numbers forever.

Invariants enforced by pure functions in `coverage.ts`: the covered set only grows; `low` only
decreases, `high` only increases; gaps inside already-covered territory only shrink or split
smaller; extending coverage (raising `high`, lowering `low`, or folding a range completion) may
introduce new gap intervals only at blocks whose processing was withheld by a per-plugin error.
This is the `setMetaMonotonic` discipline (`kysely-adapter.ts:813-825`) applied structurally.
Gap detection is the solver from §5: anything a plugin needs (from `startBlock()` up to head)
that is not in its covered set. Each indexable knows where it started and where it left off, so
it fills its own gaps independently (R3).

**Write protocol**: the dispatcher is the single coverage **writer** — the walker produces
range-completion records but never touches meta — so plain `setMeta` ordering suffices
in-process. Against cross-process races (an operator running `--reindex` while a daemon is up),
every coverage flush goes through a new adapter method
`setCoverageIfGeneration(name, gen, json)` — a small transaction that writes only when
`indexer.generation.<name>` still equals the stamped `gen`. A stale in-flight flush from
pre-drop work can therefore never resurrect dropped coverage.

**Boot + periodic reconciliation**: the boot algorithm *is* the reconciler's leading tick; the
periodic tick re-runs it forever (R3).

**`--once`** (existing flag, `core/config.ts:124,156`) — the full exit path, stated as the
deliberate lifecycle change it is:

- each snapshot plugin runs its leading poll once (`take(1)` on its timer) instead of polling
  forever;
- the reconciler emits a `done$` signal when, on one tick: the queue is drained (both lanes and
  tip empty, nothing in flight), the solver finds **no uncovered blocks for any plugin** against
  the head fetched via RPC on that tick (reachable for winner-domain plugins because of range
  completion), and the full DB-truth cross-check reports no drift (winners and difficulty exact
  diffs clean; no unsuppressed authorship sample failures);
- `connection()` pipes the merged streams through `takeUntil(done$)` — this tears down the
  never-completing siblings (`fromDisconnect`, `core/rx.ts:34-41`; the tip subscription;
  `ChainHeadWriter`);
- `SubstrateWorker.run()` treats the resulting clean stream completion as terminal — no code
  change needed: `retry({delay})` only intercepts errors, and `firstValueFrom(run$ …
  defaultIfEmpty)` resolves on completion (`worker.ts:110-115`).

Process exit still additionally requires the tip worker's own `--once` single iteration to
complete (`tip/worker.ts:53-56`); `runWorkers` returns when all workers settle
(`main.ts:36-58`).

Snapshot plugins persist nothing new — they overwrite current-state tables/meta rows exactly as
today (`polls.ts:150-185`), and `node-descriptors` keeps its existing monotonic
`DESCRIPTOR_CHECKPOINT_KEY` (`kysely-adapter.ts:41,698-702`).

## 8. Modes & CLI (`core/config.ts`, existing flag/env pattern at `config.ts:115`)

- **normal** — everything above.
- **`--once`** — existing flag; semantics per §7.
- **`--reindex[=name,…|all]`** — before workers start (in `main.ts`, where the one-shot
  topology backfill hook lives today, `main.ts:180-182`), for each named block plugin, in this
  order:
  1. increment `indexer.generation.<name>`;
  2. `setMeta("indexer.coverage.<name>", null)` — delete coverage;
  3. `plugin.dropState(db)` — delete its rows.
  The order is deliberate crash-safety: a crash between any two steps leaves at worst **extra
  rows with no coverage claiming them** — harmless, because the idempotent re-walk overwrites
  them. (The reverse order — rows dropped first — would on crash leave coverage claiming rows
  that no longer exist, a silently-covered permanent gap.) Then run normally: the boot reconcile
  sees empty coverage and re-walks from `startBlock()` to head (R4). For winner-domain plugins
  "re-walk from genesis" means from the earliest block present in the `qBlocks` map — if the
  v0.2 storage rename (`WinningSolutions` → `QBlocks`, `index.ts:526-529`) did not migrate
  pre-upgrade entries, that is the v0.2 upgrade block, and step 0 (§15) measures which it is.
  Per-plugin `dropState` scope:
  - `winners`: delete `blocks` rows.
  - `difficulty`: delete `difficulty_history` rows `WHERE source = 'block'` **only** (§9.3).
    Poll-snapshot rows — including the pre-v0.2 era's only difficulty data — are never dropped;
    they are not re-derivable and deleting them would serve no reindex purpose.
  - `authorship`: delete `validator_authorship_blocks` rows **and** clear the
    `indexer.authorship.cutover` meta key, so reads fall back to the §9.2 union (the summary
    table keeps its last values as the union's old side; values never regress during the
    re-walk, and cutover re-fires when the new table catches back up).
  - `difficulty-current`: documented **no-op** — its poll rows are not re-derivable (they stamp
    arbitrary head heights with wall-clock times) and the next poll writes forward regardless,
    so deletion serves no reindex purpose.
  - `miner-local`: documented no-op (§4.1).
  `--reindex` on a scheduler-driven snapshot plugin runs `dropState` only (next poll refills).
- **`--list-indexables`** — print the registry: each plugin's name, kind, domain, driver, and
  for block plugins the parsed coverage row (`low`/`high`/gap count/`prunedFloor`/`gen`), then
  exit. Operator affordance pairing with `--reindex`.

### Archive-pruning degradation (R5)

All validator nodes SHOULD be archive nodes; when one isn't, backfill degrades per accessor
instead of crashing. The substrate client maps "state already discarded"-class RPC errors (the
failure mode already documented at `index.ts:800-801`) to a typed `StatePrunedError`, and reads
are classified in two tiers:

- **Tier 1 — pruning-immune reads**: `getQBlockNumbers()`/paged key enumeration and
  `getQBlock()` are storage/runtime reads at the *current* head (`index.ts:451-457,524-534`);
  they work at any depth. Block hashes and headers survive pruning.
- **Tier 2 — depth-sensitive reads**: historical state at an old block hash —
  `processFinalizedBlock`/`decodeFinalizedBlock` (which perform `timestamp.now.at(blockHash)`
  and `api.derive.chain.getBlock(blockHash)` — events + author via state at that hash,
  `index.ts:559-592`), `getLastProofBlockAt` (`.at(blockHash)`, `index.ts:643-650`), and
  `getDefaultTopologyAt` (`index.ts:786-810`).

**Consequence stated plainly**: every block plugin — winner-domain included — consumes
`BlockContext.events`, a tier-2 read. The winner walk avoids historical `Difficulty` **storage**
reads, but it is **not** pruning-immune: on a pruned node, `winners` and `difficulty` floor at
exactly the same depth as the dense `authorship` walk. Winner-domain history reaches genesis
only against a true archive node.

`getDefaultTopologyAt` contract change: today the method swallows every error to `null`
(`index.ts:786-810` — catch → `null`, and `isSome=false` → `null` for legitimately-absent
pre-topology-era values). It changes to surface `StatePrunedError` distinctly while continuing
to return `null` for legitimately-absent values; **only the pruned case** moves the enrichment
floor below. Without this split, every pre-topology-era block would falsely count as degraded.

Handling, decided per case:

1. **Pruned enrichment read — `defaultTopologyAt` on a backfill item**: degrade in place — the
   winners row is written with `topology_hash = null` (matching the live path's fallback
   discipline at `blocks.ts:181`), and the block **is marked covered**. Indexing what is visible
   beats holding history hostage to one enrichment. The shallowest block that degraded this way
   is reported as `topologyEnrichmentFloor` in observability.
2. **Pruned `lastProofBlockAtParent` at the pruning boundary** (the parent is one block deeper,
   so this can fail while the block's own reads succeed): degrade in place — write the winners
   row with `miningTime = 0`, mirroring the existing `lastProofBlock ≤ 0 → miningTime 0` path
   (`blocks.ts:91-92`), and **mark the block covered**. Folded into the same
   `topologyEnrichmentFloor`-style reporting (shallowest degraded block).
3. **Pruned block-data read** (`processFinalizedBlock` fails pruned, so no `BlockContext` can be
   built): the block cannot be indexed for any plugin that needed it. For each such plugin, set
   `prunedFloor = max(prunedFloor, n + 1)`, log once per connection, and do **not** mark the
   block covered — coverage never lies about what was indexed. The walker stops descending past
   each plugin's floor.
4. **Re-probe**: each boot reconcile probes `prunedFloor − 1` once per plugin. If the read now
   succeeds (the URL rotation landed on a true archive node), the floor drops and history
   deepens automatically — no `--reindex` needed.

Floors are per-plugin state, never global — but per the tier analysis above, in this design the
three block plugins share the `processFinalizedBlock` dependency and therefore floor together.
`prunedFloor` and `topologyEnrichmentFloor` are both reported (§11) so the dashboard can render
"indexed back to block N".

**Designed but deferred — qblock-only degraded fallback**: below the state floor, a reduced
winner-domain path is possible: `getQBlock` is a runtime call at the current head (tier 1) and
yields miner/energy/reward/nonce/difficulty for any depth, and the block's timestamp is
decodable from the timestamp **inherent in the block body** (block bodies survive pruning)
instead of `timestamp.now.at`. That would let `winners`/`difficulty` continue below the floor
with `author`, proofs detail, and topology absent. It is documented here as the designed
extension point and is explicitly **out of scope for this single pass** — the floors and
re-probe above are the shipped behavior.

## 9. DB changes & migrations

One migration: `packages/core/migrations/0005_unified_indexer.ts`.

1. **`validator_authorship_blocks`** — the idempotency fix (the design's load-bearing schema
   change):

   ```sql
   create table validator_authorship_blocks (
     validator     text        not null,
     block_number  bigint      not null,
     timestamp     timestamptz not null,
     had_winner    boolean     not null,
     primary key (validator, block_number)
   );
   -- covering index for the per-validator count aggregates (union read §9.2,
   -- summary recompute):
   create index idx_vab_validator_winner on validator_authorship_blocks(validator, had_winner);
   -- block-range index for the reconciler's per-chunk sample checks (§5):
   create index idx_vab_block on validator_authorship_blocks(block_number);
   ```

   `recordValidatorAuthorship` keeps its adapter signature (`adapter.ts:293`) but becomes an
   idempotent `insert … on conflict do nothing` here, replacing the `blocks_authored + 1`
   increment (`kysely-adapter.ts:588-608`). This is what makes L2's ≤100-block crash replay,
   reconnect replays, and reconciler re-visits actually safe — the current counter plus
   per-connection dedup (`blocks.ts:143`) double-counts on every one of those paths.

   **Growth budget**: at 6s slots, ~14.4k rows/day ≈ ~5.3M rows/yr — on the order of 1 GB/yr
   including the PK and both secondary indexes. Acceptable; no retention policy until someone
   needs one (the summary cache below keeps the hot read path independent of table size).

2. **Old `validator_authorship` counter table: union reads during the walk, gated cutover,
   then repurposed as the summary cache — never dropped.** The increment write path to it is
   deleted in this pass; the table itself is kept. Rollout timeline:

   - **During the walk** (cutover flag unset): `getValidatorAuthorship`
     (`kysely-adapter.ts:616-630`) serves a **per-validator union** of the frozen old counters
     and a live aggregate over the new table — values are never stale and never regress:

     ```sql
     with n as (select validator, count(*) as cnt,
                       count(*) filter (where had_winner) as pow_cnt,
                       max(block_number) as last_block, max(timestamp) as last_at
                from validator_authorship_blocks group by validator)
     select coalesce(o.account_id, n.validator)                                as account_id,
            greatest(coalesce(o.blocks_authored, 0), coalesce(n.cnt, 0))       as blocks_authored,
            greatest(coalesce(o.blocks_authored_with_pow, 0),
                     coalesce(n.pow_cnt, 0))                                   as blocks_authored_with_pow,
            -- last-authored fields from whichever side has the higher block:
            …case on (n.last_block vs o.last_authored_block) → last_authored_block, last_authored_at…
     from validator_authorship o
     full outer join n on n.validator = o.account_id
     order by blocks_authored desc
     ```

     There is **no day-long freeze**: new tip blocks land in the new table and the union
     reflects them immediately, while historical counts are floored by the old counters until
     the backfill overtakes them. Read cost during the rollout window: one grouped aggregate
     over the new table per telemetry snapshot rebuild (1s TTL,
     `apps/server/routes/telemetry.ts:36,95`) — served by `idx_vab_validator_winner`, bounded,
     and only until cutover.
   - **Cutover**: the reconciler sets the meta key `indexer.authorship.cutover` when **all** of:
     the `authorship` coverage has `gaps = ∅`; `low ≤ max(startBlock, prunedFloor)`;
     `high ≥` the head fetched via RPC at the check (§5); and, per validator present in the old
     counter table, `newCount ≥ oldCount`. The per-validator count gate means values can only
     jump up at the flip, never regress — including on pruned deployments, where a
     shallow floor keeps `newCount` low: cutover then simply never fires and the union read
     stays in place indefinitely (correct, non-regressing values; read cost stays one bounded
     aggregate per second worst case). No gap-blind trigger: a lingering poisoned-block gap
     blocks cutover and stays visible via the drift log and observability.
   - **After cutover**: the old table is **kept as a derived summary cache**. In the same
     transaction that sets the flag, and thereafter transactionally on each coverage flush
     (§6), the adapter recomputes it from the new table — full per-validator aggregate,
     idempotent recompute-not-increment:

     ```sql
     insert into validator_authorship
       (account_id, blocks_authored, blocks_authored_with_pow, last_authored_block, last_authored_at)
     select validator, count(*), count(*) filter (where had_winner),
            max(block_number), max(timestamp)   -- timestamps are monotone with block numbers,
                                                -- so max(timestamp) is the max-block row's timestamp
     from validator_authorship_blocks group by validator
     on conflict (account_id) do update set …;
     ```

     `getValidatorAuthorship` then reads the summary table exactly as today — O(#validators),
     ordered `blocks_authored desc`, reusing `rowToValidatorAuthorship` — so the 1s-TTL
     telemetry rebuild keeps its cheap read regardless of `validator_authorship_blocks` growth.
     The full aggregate satisfies the R10 shape (`adapter.ts:305-313`): `count(*)` →
     `blocksAuthored`, `count(*) filter (where had_winner)` → `blocksAuthoredWithPow`,
     `max(block_number)` → `lastAuthoredBlock`, its timestamp → `lastAuthoredAt`.
   - The previously planned migration 0006 (drop the old table) is **cancelled**: the table's
     existing schema is exactly the summary shape, so the repurpose needs no second migration.
     The recompute is a derived-cache refresh, not a dual-write shim — there is still exactly
     one source of truth (the new table).

3. **`difficulty_history`: one new column.** Migration 0005 adds
   `source text not null default 'poll'` (values `'block'` | `'poll'`); existing rows backfill
   as `'poll'` via the default — historically every row came from the poll path. The
   `DifficultyRecord` type gains the field; the `difficulty` block plugin writes
   `source = 'block'`, the `difficulty-current` snapshot writes `source = 'poll'`. This is what
   gives the two writers ownership over their own rows: `--reindex difficulty` deletes only
   `source = 'block'` (§8), and the drift cross-check filters on it (§5). Reads
   (`getDifficultySince`, `getRecentDifficulty`) are unchanged and serve both kinds; no new
   read index is needed (the drift check's `IN` probe uses the primary key, and the `source`
   filter applies after the key lookup). Conflict handling is **per writer**: the
   `difficulty-current` poll keeps today's `ON CONFLICT (observed_at_block) DO NOTHING`
   (`kysely-adapter.ts:502`); the `difficulty` block plugin writes with **block-wins
   precedence** — `ON CONFLICT (observed_at_block) DO UPDATE SET difficulty_energy = …,
   observed_at = …, source = 'block' WHERE difficulty_history.source = 'poll'`. A poll row can
   land at a winner number (the poll stamps the finalized head, `polls.ts:84`, and difficulty
   changes exactly at winner retargets — plus every pre-migration row backfills as `'poll'`),
   and without precedence such a row would permanently block the `source = 'block'` insert:
   the §5 drift check would report that winner missing forever, `--once`'s "difficulty diffs
   clean" condition would be unreachable, and `--reindex difficulty` couldn't heal it (its
   dropState deletes only `'block'` rows). The upsert stays idempotent — a second run sees
   `source = 'block'`, the `WHERE` guard fails, and the write is a no-op.

4. **No cursor table.** Coverage lives in `meta` (§7). New adapter surface, complete list:
   `setCoverageIfGeneration` plus typed helpers over `getMeta` for coverage rows; the
   authorship union read / cutover check / summary recompute (§9.2 internals behind the
   unchanged `getValidatorAuthorship` signature); `getDifficultyAnchorBefore(sinceIso)`
   (§10.5); and the `parseIndexerObservability` extension (§11).

## 10. Difficulty deep history (R8)

**Data path**: derive from winner blocks; never read historical `Difficulty` storage. (This
bounds the walk to ~3.8k winner blocks instead of 527k and removes the per-block storage read —
it does **not** make the walk pruning-immune; see §8 and item 6 below.)

1. Every winner block's qblock carries its own difficulty (post-v0.2; surfaced as
   `ownDifficulty` in today's enrich, `blocks.ts:94`). The `difficulty` plugin, for each winner
   block, writes one `difficulty_history` row via `insertDifficultySnapshot`:
   `observed_at_block` = block number, `observed_at` = the block's timestamp inherent (from
   `BlockContext.events`), `difficulty_energy` etc. from `ctx.qblock()`, `topology_hash` from
   `ctx.defaultTopologyAt()`, `source = 'block'` (§9.3).
2. **Pre-v0.2 blocks carry no own difficulty** (`blocks.ts:104`). Decided policy: **skip** —
   write no `difficulty_history` row for them. The live pipeline's prior-block `scan` fallback
   is not reproduced here because under a newest-first `mergeMap(4)` walk the predecessor row
   may not exist yet, making the fallback order-dependent and able to bake wrong values under
   coverage. The same era-boundary decides the `blocks` table: backfilled pre-v0.2 winners
   write the `ZERO_DIFFICULTY` triple (0/0/0, `blocks.ts:31-35`) into
   `difficulty_energy`/`min_diversity`/`min_solutions` (NOT NULL columns,
   `0001_initial.ts:39-41`) — legacy-era difficulty is not trustworthy, so a stated sentinel
   beats an order-dependent guess. Observability reports `difficultyDataStartBlock` and the
   UI's "All Time" range starts where real data exists. **Step 0 (§15) measures this era**: the
   minimum key in the `qBlocks` map vs the v0.2 upgrade block, and the pre-v0.2 winner count —
   so the reachable winner depth and the expected `difficultyDataStartBlock` are stated from
   the live chain, not assumed. If the v0.2 rename did not migrate pre-upgrade entries, the
   winner walk (and R4's "genesis") starts at the upgrade block (§8).

   **Step 0 measured (2026-07-02, live chain at head 530,795 — archive node confirmed: state
   readable at block 1):** the `qBlocks` map holds **3,855 entries keyed by substrate block
   number**, spanning blocks **394,362 → 530,752**; boundary entries plus 12 samples spread
   across the range **all carry `difficulty`** — zero difficulty-less entries observed, so the
   skip policy is a safety net that never fires on this chain. Runtime upgrades sit at spec
   103→107 @ 337,968, 107→108 @ 415,217, 108→110 @ 474,594; the map's floor (394,362) falls
   inside the spec-107 era, so pre-rename winners were not migrated. Therefore:
   `difficultyDataStartBlock = 394,362`, the winner walk and R4's "genesis" for winner-domain
   plugins start there, expected lane-W volume ≈ 3.9k blocks, and `prunedFloor` is expected to
   rest at the walk start on this deployment.
3. **Two series, one table — the semantics stated explicitly.** The block-derived series is the
   **mined-against** difficulty: each winner row records the difficulty the win was solved
   against (`sol.difficulty` from the qblock), i.e. the pre-retarget value, timestamped at the
   win block. The live `difficulty-current` poll records the **post-retarget current**
   difficulty at the head. Consequences, accepted: the backfilled step function lags the true
   difficulty by one win interval — ~14 minutes on average (527k blocks × 6s ÷ 3.8k winners),
   worst-case hours during slow-win stretches; and difficulty changes with no intervening
   winner (topology switch, governance/curve change) are captured **only in the live-polled
   era** — the winner-derived history shows them at the next win. A small step discontinuity at
   the live/backfill seam is possible and acceptable for a chart whose backfilled resolution is
   the win cadence anyway.
4. **Coexistence — keys are usually disjoint.** `difficulty-current` stamps
   `observedAtBlock = current finalized head` (`polls.ts:84`), which is almost never a winner
   block (~3.8k winners in ~527k blocks), and it writes only when the deduped value changes
   (`polls.ts:94-96`). So post-redesign `difficulty_history` is a **mixed composition**:
   poll rows at arbitrary head numbers with wall-clock `observed_at`, plus block rows at winner
   numbers with block-timestamp `observed_at`, distinguished by `source` (§9.3). The
   same-block collision resolves **block-wins over poll**: the block plugin's upsert converts
   an occupying `'poll'` row to `'block'` (§9.3), and poll rows never overwrite block rows
   (their write stays `DO NOTHING`). This keeps winner numbers deterministically owned by the
   block series — required for the §5 drift check and `--reindex difficulty` to converge. Both
   the chart and `getDifficultySince` handle the mix fine: same row shape,
   `observed_at`-ordered.
5. **Reads & the window anchor.** `getDifficultySince(sinceIso)` (`adapter.ts:247`,
   `kysely-adapter.ts:516-524`) filters and orders by `observed_at`; backfilled rows carry real
   block timestamps, so 1h/6h/12h/24h/7d/1m/YTD/All-Time queries return the in-window rows as
   soon as backfill reaches the requested depth. In-window rows alone are not enough: rows
   exist only at winner blocks (~14 min apart) and on poll-value changes, so a window shorter
   than the current stable-difficulty stretch (common at 1h) would be empty. The task-#24
   `/api/difficulty-history?since=` endpoint therefore returns the window rows **plus one
   anchor row at-or-before `since`** — a single extra
   `ORDER BY observed_at DESC LIMIT 1` query, exposed as adapter method
   `getDifficultyAnchorBefore(sinceIso)` (§9.4) — so every window renders the prevailing step
   instead of an empty chart. The price-panel range selector (task #25) consumes it.
6. Cost: winner enumeration is paged keys shared with the reconciler (§5) and the qblock read
   is already memoized for the `winners` plugin — marginal cost ≈ 0 extra RPCs beyond the
   winner items themselves. The alternative — historical `Difficulty` state reads — would
   require a walk of every block (~139× more) plus one storage read each. Under pruning the two
   approaches floor at the same depth (§8); the winner derivation's advantage is volume, not
   pruning immunity.

## 11. Observability

`IndexerObservability` (`packages/shared/telemetry/response.ts:32`, persisted to the
`INDEXER_OBSERVABILITY_KEY` meta row and read by the server at `routes/telemetry.ts:88` and
`routes/health.ts:12`) gains additive fields, flushed on each coverage flush:

```ts
indexer?: {
  backfillQueueDepth: number;               // both lanes + tip
  coverage: Record<string, {
    low: string; high: string;          // u64-as-string, house style (response.ts:33-34)
    gapBlocks: number;                  // see semantics below
    prunedFloor: string | null;
    topologyEnrichmentFloor: string | null;   // winners plugin only (§8 cases 1–2)
    generation: number;
  }>;
  difficultyDataStartBlock: string | null;    // first block with own difficulty; expected ≈
                                              // the v0.2 upgrade block, measured in step 0
};
```

`gapBlocks` semantics under §7's range-completion model: it counts only blocks whose processing
failed or is pending retry — never the non-winner numbers inside enumerated winner ranges. A
healthy fully-backfilled deployment reads `gapBlocks: 0` for every plugin.

**Read-path change (required, not optional)**: `parseIndexerObservability`
(`packages/core/api/db/adapter.ts:32-64`) whitelist-reconstructs the meta payload, so without a
change the new field would be silently dropped on every read. The parser is extended to validate
and pass through the optional `indexer` field — tolerant of absence for pre-redesign rows,
mirroring the existing `modes?` handling (`adapter.ts:62,95-119`) — with a parse test in the
same suite. §12 reflects this.

The server exposes this under a new `indexer` field in `/api/telemetry` — additive only (R10).
The UI can render backfill progress ("indexed back to block N", pruned-depth warnings) without
any new endpoint. `--list-indexables` prints the same data on the CLI.

## 12. API compatibility guarantees (R10)

- Every row lands in the same tables (or, for authorship, behind unchanged adapter signatures
  with a value-stable union-then-cutover, §9.2). Server read paths change in exactly three
  named, additive ways: the `indexer` telemetry field plus the `parseIndexerObservability`
  extension that lets it through (§11); the authorship union/cutover read behind the unchanged
  `getValidatorAuthorship` signature (§9.2); and the task-#24 `/api/difficulty-history`
  endpoint contract, which includes the window-anchor row (§10.5). Nothing else on the server
  is touched.
- **Certification gate** (implementation step 8, before the worker swap is merged): server
  contract tests in `apps/server` assert that pre-redesign `/api/telemetry` fixture payloads
  still validate against the shared response types (`packages/shared/telemetry/response.ts`)
  and that the route handler produces a superset of the fixture — not just "we believe it's
  additive", but a named, failing-by-default test.
- During the rollout: authorship values are served from the per-validator union — historical
  counts floored by the old counters, new tip blocks reflected immediately, no freeze and no
  regression, with cutover gated per §9.2; difficulty/current snapshots continue
  uninterrupted; winners writes are the same rows from a different call site.

## 13. Concurrency, rate limiting & RPC cost budget

Honest accounting — `processFinalizedBlock` is not one RPC, and `api.derive.chain.getBlock`
fans out internally (block body + events-at-hash + session/validators-at-hash for author
resolution ≈ 3 calls). Per-block sub-RPC budget:

| item | sub-RPCs |
|---|---|
| any block (`BlockContext.events`): `getBlockHash` + `getHeader` + derive fan-out (~3) + `timestamp.now.at` | ~6 |
| winner block extras: nonce `getQBlock` inside the decode (`index.ts:625`) + memoized `ctx.qblock()` + `lastProofBlockAtParent` + amortized `defaultTopologyAt` (`getBlockHash` + `.at`) | +3–4 → **~9–10 total** |
| non-winner block (authorship only; winner plugins already range-covered) | ~6 total |

At `backfillBlocksPerSec = 5` **per lane** (flag + env per `config.ts:115` pattern):

- **lane W (winner enumeration)**: ~3.8k winners ÷ 5 blk/s ≈ 760s ≈ **~13 minutes**, at
  ~9–10 sub-RPCs per winner ≈ **~45–50 RPC/s** while it drains. Because lane W is a real queue
  lane with its own token allowance and heap priority over lane D (§5), this figure holds on a
  **fresh deploy** — deep difficulty history and the full winners/topology backfill land within
  the first quarter-hour, concurrently with (not behind) the dense walk.
- **lane D (dense walk)**: 527k blocks ÷ 5 blk/s ≈ 105,400s ≈ **~1.2 days** (plan for 1.2–1.5
  days with reconnects), at ~6 sub-RPCs per block ≈ **~30 RPC/s** steady-state. This is the
  authorship-to-genesis time and hence the earliest §9.2 cutover time.
- **combined**: during the initial ~13-minute overlap both lanes run — up to ~75–80 RPC/s peak
  (`backfillConcurrency = 4` is shared across lanes; the heap order guarantees lane W claims
  dispatcher capacity first, so lane W's 13 minutes hold even if lane D is throttled below its
  allowance during the overlap). After lane W drains: ~30 RPC/s. Well under a websocket
  validator endpoint's capacity but respectful of shared nodes; operators can raise the per-lane
  rate on dedicated archive nodes.
- tip items bypass the token buckets and the heap (tip bucket drained first, promotion rule 1),
  and the 750ms tip-quiet gate yields the socket around live events — backfill can never starve
  tip handling, by construction plus by socket-level courtesy. Tip cost: ~1 block/6s ≈ 1–2
  RPC/s.
- reconciler: solver-only ticks are RPC-free apart from one head fetch; the boot + hourly
  enumeration is O(total winner count) paged keys (§5).

Knobs (all `config.ts` flag+env, defaults): `backfillBlocksPerSec=5` (per lane),
`backfillConcurrency=4` (shared), `reconcileIntervalSec=900`, `dbTruthCheckIntervalSec=3600`,
walker chunk 64, queue low-water 128 per lane, tip-quiet 750ms, tip gap-fill window 32,
coverage flush 100 blocks / 5s, authorship sample chunks 4 per cross-check run.

## 14. Testing strategy

Pure/unit (no I/O):

- `coverage.ts`: property tests with fast-check — union/subtract round-trips, covered-set
  monotonicity and gap invariants (§7), item- and range-completion folds, solver correctness
  (`uncovered ∪ covered = [start, head]`, disjoint), and the convergence property:
  **winner-domain coverage converges to `[start, head]`** given any interleaving of winner-item
  completions and range-completion records over a randomly generated winner set.
- `queue.ts`: tip preemption (tip item enqueued mid-backfill is the next pull), lane ordering
  (lane W pulled before lane D; tip before both), per-lane token buckets and tip-quiet gate
  with injected clock, dedup `pending` merge, and all three promotion rules (tip promotion
  flips `source`; lane-W promotion re-lanes a lane-D item; reverse-direction duplicates are
  pure unions).
- driver: `tryPull` → `{retryAtMs}` schedules a timer retry; enqueue-Subject wake-up from the
  empty state; partition routes tip→`concatMap`, backfill→`mergeMap(4)`.
- Reconciler target computation: coverage fixtures → expected uncovered sets, floor handling,
  generation-mismatch flush rejection, head taken from the per-tick RPC fetch (not persisted
  observability).

Fakes:

- `FakeSubstrateClient` (`clients/substrate-client/fake.ts:29`) extended with a `pruneBelow(n)`
  knob that throws `StatePrunedError` from tier-2 reads below `n`, plus paged key enumeration —
  tests both R5 tiers, the boundary `lastProofBlockAtParent` case (§8.2), the
  pruned-vs-absent `getDefaultTopologyAt` split, floor ratchet, and boot re-probe.
- pglite adapter (pattern in `kysely-adapter.test.ts`) for plugin idempotency — run `onBlock`
  twice, assert one row — for `winners`, `difficulty`, `authorship`; the difficulty collision
  case (a `'poll'` row pre-seeded at a winner number → `onBlock` converts it to `'block'` via
  the precedence upsert → §5 drift check reports clean; a second `onBlock` is a no-op);
  `dropState` scoping (difficulty deletes only `source='block'`, poll rows survive; authorship
  clears the cutover key); the authorship union read (GREATEST semantics, last-authored from
  the newer side), cutover gating (per-validator `newCount ≥ oldCount`, gap/low/high
  conditions), and the summary recompute; `getDifficultyAnchorBefore`;
  `parseIndexerObservability` round-trips the new `indexer` field and tolerates its absence.

Integration:

- Dispatcher with one always-throwing plugin: siblings' coverage advances, the thrower's block
  lands in its gap list (including inside a range-completed chunk), the reconciler re-enqueues
  it — proves error isolation.
- Worker-level reconnect test reusing the existing pattern in `substrate/worker.test.ts`:
  coverage survives reconnect, no double rows after replay.
- End-to-end `--once` against FakeSubstrateClient + pglite: seeded chain with winners, a gap,
  a pruned floor, non-winner stretches, and pre-v0.2 blocks → assert final rows (including
  `ZERO_DIFFICULTY` triples on pre-v0.2 winners and no pre-v0.2 difficulty rows), converged
  winner-domain coverage, coverage JSON, observability, `done$` firing, and clean process-level
  exit (both workers complete, `main.ts:36-58`).
- R10 certification tests (§12), including an authorship fixture asserting the union read's
  shape and ordering.

## 15. Implementation order (single pass, R6) — each step with its gate

0. **Measurement probe** (no code shipped): against the live chain, read the minimum key of
   `qBlocks` via paged keys, compare with the v0.2 upgrade height, and count pre-v0.2 winners.
   Locating the upgrade height: `getLastRuntimeUpgrade` cannot supply it —
   `system.lastRuntimeUpgrade` carries only `{spec_version, spec_name}` and the client returns
   the spec version as a sentinel (`clients/substrate-client/index.ts:417-434`). Use the
   operator-known upgrade height from deploy records, or binary-search block heights probing
   `state_getRuntimeVersion(at hash)` for the spec-version transition (archive node, ~20
   probes). Record the reachable winner depth and the expected `difficultyDataStartBlock` in
   the deploy notes; this fixes the real meaning of R4's "re-walk from genesis" for
   winner-domain plugins (§8, §10.2) and the expected "All Time" range start. *Gate: numbers
   recorded; §10.2 expectations confirmed or corrected before step 4.*
1. `pipeline/coverage.ts` (item + range completion) + property tests, including winner-domain
   convergence. *Gate: fast-check suite green.*
2. `pipeline/plugin.ts` interfaces — including `BlockContext` (§4) — + `buildRegistry`
   skeleton. *Gate: typecheck.* (Self-contained: steps 2 and 4 no longer depend on
   `dispatch.ts`.)
3. Migration `0005` + adapter changes: `validator_authorship_blocks` insert behind the
   unchanged `recordValidatorAuthorship` signature; the authorship union read, cutover check,
   and summary recompute; `difficulty_history.source` column + record plumbing;
   `setCoverageIfGeneration`; `getDifficultyAnchorBefore`. *Gate: pglite migration + adapter
   tests, including run-twice-one-row, union/cutover, and source-scoped delete.*
4. Port logic into plugins (`winners`, `difficulty`, `authorship`, four scheduler snapshots +
   the `miner-local` descriptor entry) — bodies are moves from
   `blocks.ts`/`polls.ts`/`descriptor/iteration.ts`, not rewrites. *Gate: pglite plugin tests
   prove rows byte-identical to the ones the old paths write for the same **post-v0.2**
   inputs; for pre-v0.2 winner inputs (whose old-path values were order- and seed-dependent),
   assert the decided values instead — `ZERO_DIFFICULTY` blocks-row triple, no
   `difficulty_history` row (§10.2).*
5. `queue.ts` (lanes, promotion), driver, `producers.ts` (walker range-completion tracking,
   reconciler head fetch via the new ports method), `dispatch.ts` + unit/integration tests.
   *Gate: tip preemption, lane ordering, promotion, isolation, crash-replay, and
   range-completion convergence tests green.*
6. `StatePrunedError` mapping + `getDefaultTopologyAt` pruned-vs-absent contract change +
   paged key enumeration (`keysPaged`) in the substrate client + `FakeSubstrateClient`
   extensions + R5 tests (including the boundary `lastProofBlockAtParent` case). *Gate:
   two-tier degradation tests green.*
7. Swap `SubstrateWorker.connection()` stream list + the `--once` `takeUntil(done$)` (§3, §7);
   rewire `main.ts` to `[tip, substrate]`; delete `blocks.ts`, `backfill.ts`,
   `backfill-topology.ts`, `descriptor/worker.ts` and the `runTopologyBackfill` hook
   (`main.ts:180-182`). *Gate: worker reconnect tests + full indexer test suite green.*
8. **R10 certification**: server contract/snapshot tests over pre-redesign `/api/telemetry`
   fixtures (§12), including the authorship union shape. *Gate: fixtures validate; this gate
   blocks merging the step-7 swap.*
9. `--reindex` (generation-first order, §8), `--list-indexables` flags + generation plumbing.
   *Gate: reindex e2e test (generation bump → coverage clear → drop → re-walk → identical
   rows) plus a crash-between-steps test (kill after coverage clear, before dropState → rerun
   heals via idempotent re-walk).*
10. Observability fields + `parseIndexerObservability` extension + parse tests + server
    `indexer` telemetry field (additive) + `getDifficultyAnchorBefore` wired into the task-#24
    endpoint contract (§10.5). *Gate: R10 tests still green with the new field present; parse
    round-trip green.*
11. End-to-end `--once` run (§14). *Gate: clean exit with full coverage — winner-domain
    included — on the seeded chain.*

R10 holds throughout: steps 3–5 prove row-compatibility before step 7 changes any behavior, and
step 8 is a hard gate on the swap.

## 16. Risks & mitigations

| risk | mitigation |
|---|---|
| Coverage ledger drifts from actual rows (bug, manual DB surgery) | per-plugin DB-truth checks at boot + hourly: winners exact diff (paged keys vs `blocks` rows), difficulty exact diff (winner numbers vs `source='block'` rows, pre-v0.2 excluded), authorship chunk sampling with re-enqueue + suppression (§5) |
| Crash between row write and coverage flush | all writes idempotent (incl. authorship after §9); ≤100-block replay is a no-op |
| Stale in-flight coverage write after `--reindex` from another process | generation stamp + `setCoverageIfGeneration` conditional write (§7) |
| Crash mid-`--reindex` | generation + coverage cleared **before** dropState; a crash leaves only extra uncovered rows, healed by the idempotent re-walk (§8) |
| Authorship values freeze or regress mid-rollout | per-validator union read (GREATEST of old counter / new count) during the walk; cutover gated on `newCount ≥ oldCount` per validator + zero gaps + head reached; post-cutover summary cache recomputed transactionally (§9.2) |
| Authorship read cost grows with the new table | summary cache keeps `/api/telemetry` reads O(#validators); covering + block indexes bound the recompute and sample checks; growth budget stated (~5.3M rows/yr) (§9) |
| Backfill starves tip handling on the shared socket | structural queue priority + per-lane token buckets with tip exemption + 750ms tip-quiet gate + tip promotion rule (§5) |
| Pruned node halts backfill or corrupts coverage | per-plugin `prunedFloor`; never marked covered when unindexed; boundary enrichments degrade in place (topology null, miningTime 0); boot re-probe deepens history on archive rotation. Honest limit: all three block plugins floor at the same depth — the qblock-only fallback below the floor is documented but deferred (§8) |
| Pre-v0.2 difficulty fallback bakes wrong values under unordered walk | skipped entirely in `difficulty_history`; blocks rows get the stated `ZERO_DIFFICULTY` sentinel; range start measured in step 0 and reported (§10.2, §15) |
| Winner-derived series misread as live difficulty | semantics stated: mined-against values, ~14-min average lag, intra-win changes visible only in the live-polled era; `source` column separates the series (§10.3–4) |
| Short range-selector windows render empty | window-anchor row from `getDifficultyAnchorBefore` in the task-#24 endpoint (§10.5) |
| One poisoned block wedges a plugin | per-plugin catch → own gap list (also inside range-completed chunks); siblings advance; drift log keeps it visible; poisoned gaps block authorship cutover rather than undercounting (§6, §9.2) |
| One-pass rewrite breaks the working live indexer | `SubstrateWorker.run()` kept verbatim; swap confined to `connection()` stream contents plus the stated `--once` `takeUntil`; plugin bodies are moves; step-8 contract gate before the swap merges (§3, §15) |
| Reconciler cost grows with total winner count | enumeration is paged keys only, at boot + hourly; 15-minute ticks run the RPC-free solver; cost band stated (§5, §13) |
| Concept count (queue + lanes + coverage + producers) burdens future maintainers | each piece is a small pure class with its own test file; `--list-indexables` and the observability field expose runtime state; this spec is the map |
| Dense walk load on shared validators | 5 blk/s per lane (~30 RPC/s dense steady-state, ~45–50 RPC/s for the ~13-minute lane-W drain, ≤~80 RPC/s combined peak), config knobs, tip-quiet gate (§13) |
