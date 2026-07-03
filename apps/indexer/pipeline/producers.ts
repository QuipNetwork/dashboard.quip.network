// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L1 producers (spec §5), each a per-connection ConnectionStream:
//
//   TipEnqueuer     — finalized-head subscription → tip-bucket enqueues, with
//                     ≤32-block gap fill for short subscription blips.
//   BackfillWalker  — turns the reconciler's per-plugin uncovered sets into
//                     lane-W (winner enumeration) and lane-D (dense) queue
//                     work, pull-driven by a low-water mark; tracks lane-W
//                     chunks and produces range-completion records — the
//                     mechanism that makes winner-domain coverage converge
//                     (spec §7/D1). The walker only PRODUCES records; the
//                     dispatcher stays the single coverage writer.
//   Reconciler      — timer(0, 900s): fetches the finalized head via RPC,
//                     runs the pure solver per plugin, primes the walker.
//                     Boot tick = boot backfill; the same call heals gaps
//                     forever (R3). DB-truth cross-checks run at boot +
//                     hourly. Under --once it emits done$ when everything
//                     is drained, covered, and drift-free.

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import { Subject, timer, exhaustMap, ignoreElements, tap, type Observable } from "rxjs";

import type { SubstrateHead } from "../clients/substrate-client";
import { runEffect } from "../core/rx";
import type { IndexerState } from "../core/state";
import type { ChainClient, ConnectionStream, HeadSource } from "../substrate/ports";
import { fromChainSubscription } from "../substrate/streams";
import { isComplete, uncovered, type Coverage, type Interval } from "./coverage";
import type { BlockIndexable } from "./plugin";
import type { BackfillLane, QueueCore } from "./queue";

export interface RangeCompletion {
  plugin: string;
  range: [number, number];
}

// The dispatcher-owned coverage view the reconciler reads (dispatch.ts's
// CoverageStore implements this structurally — producers never import
// dispatch, keeping the dependency one-directional).
export interface CoverageAccess {
  ensureLoaded(plugin: BlockIndexable, client: ChainClient): Promise<void>;
  coverageFor(name: string): Coverage;
  /** Boot re-probe succeeded: drop the pruned floor so history deepens. */
  clearFloor(name: string): void;
  /** Persist any dirty coverage now (the --once exit must not lose state). */
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// TipEnqueuer

const TIP_GAP_FILL_MAX = 32;

export class TipEnqueuer implements ConnectionStream {
  private lastSeen: number | null = null;

  constructor(
    private readonly client: Pick<HeadSource, "subscribeFinalizedHeads">,
    private readonly queue: QueueCore,
    private readonly wake: () => void,
    private readonly blockPluginNames: ReadonlySet<string>,
  ) {}

  stream(): Observable<never> {
    return fromChainSubscription<SubstrateHead>((cb) =>
      this.client.subscribeFinalizedHeads(cb),
    ).pipe(
      tap((h) => this.onHead(Number(h.number))),
      ignoreElements(),
    );
  }

  private onHead(n: number): void {
    if (!Number.isFinite(n)) return;
    // Short subscription blips are filled at tip priority; anything larger
    // is the reconciler's job (its solver sees the (high, head] hole).
    const from =
      this.lastSeen !== null && n - this.lastSeen <= TIP_GAP_FILL_MAX ? this.lastSeen + 1 : n;
    for (let b = from; b <= n; b++) this.queue.enqueueTip(b, this.blockPluginNames);
    this.lastSeen = Math.max(this.lastSeen ?? n, n);
    this.wake();
  }
}

// ---------------------------------------------------------------------------
// BackfillWalker

export interface WalkerWork {
  // Per-plugin uncovered intervals (ascending, disjoint), by domain.
  winnerPlugins: Map<string, Interval[]>;
  everyPlugins: Map<string, Interval[]>;
  // Enumerated winner block numbers, ascending.
  winnerSet: number[];
}

export interface WalkerDeps {
  queue: QueueCore;
  wake: () => void;
  onRangeComplete: (record: RangeCompletion) => void;
  chunkSize?: number; // 64
  lowWater?: number; // 128
}

/** Sorted-ascending interval membership via binary search on starts. */
function intervalsContain(intervals: Interval[], n: number): boolean {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = intervals[mid]!;
    if (n < a) hi = mid - 1;
    else if (n > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Union of many ascending interval lists, merged and ascending. */
function mergeIntervals(lists: Iterable<Interval[]>): Interval[] {
  const flat: Interval[] = [];
  for (const list of lists) flat.push(...list);
  flat.sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of flat) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) {
      if (b > last[1]) out[out.length - 1] = [last[0], b];
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

/** Consumes a merged interval set newest-first in fixed-size chunks. */
class ChunkCursor {
  // Kept ascending; consumed from the back (newest first).
  constructor(
    private readonly intervals: Interval[],
    private readonly chunkSize: number,
  ) {}

  next(): [number, number] | null {
    const top = this.intervals[this.intervals.length - 1];
    if (!top) return null;
    const [lo, hi] = top;
    const a = Math.max(lo, hi - this.chunkSize + 1);
    if (a > lo) this.intervals[this.intervals.length - 1] = [lo, a - 1];
    else this.intervals.pop();
    return [a, hi];
  }

  hasWork(): boolean {
    return this.intervals.length > 0;
  }
}

interface ChunkTracker {
  range: [number, number];
  remaining: Set<number>;
  plugins: string[];
}

export class BackfillWalker implements ConnectionStream {
  private readonly chunkSize: number;
  private readonly lowWater: number;

  private winnerMembership = new Map<string, Interval[]>();
  private everyMembership = new Map<string, Interval[]>();
  private winnerSet: number[] = [];
  private wCursor = new ChunkCursor([], 1);
  private dCursor = new ChunkCursor([], 1);
  private readonly trackerByBlock = new Map<number, ChunkTracker>();

  constructor(private readonly deps: WalkerDeps) {
    this.chunkSize = deps.chunkSize ?? 64;
    this.lowWater = deps.lowWater ?? 128;
  }

  /** Replace the plans (reconciler tick). Outstanding trackers survive. */
  prime(work: WalkerWork): void {
    this.winnerMembership = work.winnerPlugins;
    this.everyMembership = work.everyPlugins;
    this.winnerSet = work.winnerSet;
    this.wCursor = new ChunkCursor(mergeIntervals(work.winnerPlugins.values()), this.chunkSize);
    this.dCursor = new ChunkCursor(mergeIntervals(work.everyPlugins.values()), this.chunkSize);
    this.topUp();
  }

  /** Pull-driven production: emit chunks only while a lane is under water. */
  topUp(): void {
    let produced = false;
    while (this.queue.backfillDepth("W") < this.lowWater) {
      const chunk = this.wCursor.next();
      if (!chunk) break;
      this.produceWinnerChunk(chunk);
      produced = true;
    }
    while (this.queue.backfillDepth("D") < this.lowWater) {
      const chunk = this.dCursor.next();
      if (!chunk) break;
      this.produceDenseChunk(chunk);
      produced = true;
    }
    if (produced) this.deps.wake();
  }

  /**
   * The dispatcher reports EVERY completed block here (whichever bucket
   * served it), so an enumerated winner promoted to tip still closes its
   * lane-W chunk.
   */
  notifyCompleted(block: number): void {
    const tracker = this.trackerByBlock.get(block);
    if (!tracker) return;
    this.trackerByBlock.delete(block);
    tracker.remaining.delete(block);
    if (tracker.remaining.size === 0) this.emitRecords(tracker);
  }

  hasPlannedWork(): boolean {
    return this.wCursor.hasWork() || this.dCursor.hasWork() || this.trackerByBlock.size > 0;
  }

  /** Re-enqueue drift repairs from the reconciler's cross-check. */
  enqueueDrift(lane: BackfillLane, blocks: number[], plugin: string): void {
    for (const b of blocks) this.queue.enqueueBackfill(b, lane, new Set([plugin]));
    if (blocks.length > 0) this.deps.wake();
  }

  private get queue(): QueueCore {
    return this.deps.queue;
  }

  private produceWinnerChunk(range: [number, number]): void {
    const [a, b] = range;
    const plugins = [...this.winnerMembership.entries()]
      .filter(([, intervals]) => intervals.some(([x, y]) => x <= b && y >= a))
      .map(([name]) => name);
    const winners = this.winnersIn(a, b);
    if (winners.length === 0) {
      // Enumeration proves the whole range carries nothing for these
      // plugins — no queue round-trip needed.
      for (const plugin of plugins) this.deps.onRangeComplete({ plugin, range });
      return;
    }
    const tracker: ChunkTracker = { range, remaining: new Set(winners), plugins };
    for (let i = winners.length - 1; i >= 0; i--) {
      const w = winners[i]!;
      const pending = new Set(
        [...this.winnerMembership.entries()]
          .filter(([, intervals]) => intervalsContain(intervals, w))
          .map(([name]) => name),
      );
      this.trackerByBlock.set(w, tracker);
      this.queue.enqueueBackfill(w, "W", pending);
    }
  }

  private produceDenseChunk([a, b]: [number, number]): void {
    for (let n = b; n >= a; n--) {
      const pending = new Set(
        [...this.everyMembership.entries()]
          .filter(([, intervals]) => intervalsContain(intervals, n))
          .map(([name]) => name),
      );
      if (pending.size > 0) this.queue.enqueueBackfill(n, "D", pending);
    }
  }

  private winnersIn(a: number, b: number): number[] {
    // winnerSet ascending: locate the first ≥ a, walk to b.
    let lo = 0;
    let hi = this.winnerSet.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.winnerSet[mid]! < a) lo = mid + 1;
      else hi = mid;
    }
    const out: number[] = [];
    for (let i = lo; i < this.winnerSet.length && this.winnerSet[i]! <= b; i++) {
      out.push(this.winnerSet[i]!);
    }
    return out;
  }

  private emitRecords(tracker: ChunkTracker): void {
    for (const plugin of tracker.plugins) {
      this.deps.onRangeComplete({ plugin, range: tracker.range });
    }
  }

  stream(): Observable<never> {
    // Pull-driven top-up: cheap depth check every 250ms keeps the lanes fed
    // without producer/consumer coupling.
    return timer(0, 250).pipe(
      tap(() => this.topUp()),
      ignoreElements(),
    );
  }
}

// ---------------------------------------------------------------------------
// Reconciler

export interface ReconcilerDeps {
  db: DatabaseAdapter;
  client: ChainClient;
  queue: QueueCore;
  walker: BackfillWalker;
  store: CoverageAccess;
  registry: BlockIndexable[];
  now: () => number;
  reconcileIntervalSec?: number; // 900
  crossCheckIntervalMs?: number; // 3_600_000
  once?: boolean;
  rng?: () => number;
  // Observability sinks (spec §11): when present, each tick refreshes
  // state.observability.indexer with the per-plugin coverage summary.
  state?: IndexerState;
  enrichmentFloor?: () => number | null;
}

const AUTHORSHIP_SAMPLE_CHUNKS = 4;
const AUTHORSHIP_SAMPLE_WIDTH = 64;

export class Reconciler implements ConnectionStream {
  /** Fires (then completes) when the --once exit condition holds (spec §7). */
  readonly done$ = new Subject<void>();

  private lastCrossCheckAt: number | null = null;
  // Drift blocks re-enqueued once that STAYED missing: suppressed for the
  // generation so a genuinely unindexable block can't flap --once or spam
  // the log (spec §5).
  private readonly suppressedDifficulty = new Set<number>();
  private readonly suppressedAuthorshipChunks = new Set<string>();
  private readonly difficultyMissCounts = new Map<number, number>();
  private readonly authorshipChunkMissCounts = new Map<string, number>();

  constructor(private readonly deps: ReconcilerDeps) {}

  stream(): Observable<never> {
    const intervalMs = (this.deps.reconcileIntervalSec ?? 900) * 1000;
    return timer(0, intervalMs).pipe(
      exhaustMap(() => runEffect("reconcile", () => this.tick())),
    ) as Observable<never>;
  }

  /** One reconcile pass. Public for tests and for --once's deciding tick. */
  async tick(): Promise<void> {
    const { deps } = this;
    const head = Number(await deps.client.getFinalizedHead());
    if (!Number.isFinite(head)) return;

    const blockPlugins = deps.registry;
    for (const plugin of blockPlugins) await deps.store.ensureLoaded(plugin, deps.client);

    // Boot re-probe (spec §8.4): if a plugin's pruned floor is now readable
    // (URL rotation landed on a true archive node), drop it — the solve
    // below immediately deepens the walk. No --reindex needed.
    await this.reprobeFloors();

    // Pure solve per plugin, split by domain for the walker's lanes.
    const winnerPlugins = new Map<string, Interval[]>();
    const everyPlugins = new Map<string, Interval[]>();
    for (const plugin of blockPlugins) {
      const cov = deps.store.coverageFor(plugin.name);
      const holes = uncovered(cov, head);
      if (holes.length === 0) continue;
      (plugin.domain === "winner-blocks" ? winnerPlugins : everyPlugins).set(plugin.name, holes);
    }

    // The winner enumeration feeds both the lane-W plan and the cross-check.
    const needsEnumeration = winnerPlugins.size > 0 || this.crossCheckDue();
    const winnerSet = needsEnumeration
      ? (await deps.client.getQBlockNumbers()).map(Number).sort((a, b) => a - b)
      : [];

    deps.walker.prime({ winnerPlugins, everyPlugins, winnerSet });

    let crossCheckClean = true;
    if (this.crossCheckDue() || this.deps.once) {
      crossCheckClean = await this.runCrossCheck(winnerSet);
      this.lastCrossCheckAt = deps.now();
    }

    await this.maybeCutover(head);
    this.publishProgress();

    if (
      this.deps.once &&
      crossCheckClean &&
      deps.queue.isDrained() &&
      !deps.walker.hasPlannedWork() &&
      blockPlugins.every((p) => isComplete(deps.store.coverageFor(p.name), head))
    ) {
      // Persist before tearing the connection down — done$ unwinds the
      // dispatcher's flush timer with it.
      await deps.store.flush();
      this.done$.next();
      this.done$.complete();
    }
  }

  private crossCheckDue(): boolean {
    const interval = this.deps.crossCheckIntervalMs ?? 3_600_000;
    return this.lastCrossCheckAt === null || this.deps.now() - this.lastCrossCheckAt >= interval;
  }

  // One probe per plugin per connection: reading at the floor block itself.
  private readonly reprobed = new Set<string>();

  private async reprobeFloors(): Promise<void> {
    for (const plugin of this.deps.registry) {
      if (this.reprobed.has(plugin.name)) continue;
      const floor = this.deps.store.coverageFor(plugin.name).prunedFloor;
      if (floor === null) continue;
      this.reprobed.add(plugin.name);
      try {
        const events = await this.deps.client.processFinalizedBlock(String(floor));
        if (events !== null) {
          console.warn(
            `[indexer] pruned floor at block ${floor} is readable again; deepening "${plugin.name}"`,
          );
          this.deps.store.clearFloor(plugin.name);
        }
      } catch {
        // Still pruned (or transient): keep the floor; next connection re-probes.
      }
    }
  }

  /** DB-truth drift detector (spec §5). Returns whether everything is clean. */
  private async runCrossCheck(winnerSetAsc: number[]): Promise<boolean> {
    const { deps } = this;
    const winnerSet =
      winnerSetAsc.length > 0
        ? winnerSetAsc
        : (await deps.client.getQBlockNumbers()).map(Number).sort((a, b) => a - b);
    const winnerStrings = winnerSet.map(String);
    let clean = true;

    // winners: today's Backfill.missing() diff, kept as the ledger check.
    const existingBlocks = new Set(await deps.db.getExistingBlockNumbers(winnerStrings));
    const missingWinners = winnerSet.filter((n) => !existingBlocks.has(String(n)));
    if (missingWinners.length > 0) {
      clean = false;
      console.warn(
        `[indexer] coverage drift: ${missingWinners.length} winner block(s) missing from blocks; re-enqueueing`,
      );
      deps.walker.enqueueDrift("W", missingWinners, "winners");
    }

    // difficulty: winner numbers vs winner-derived rows. Suppression keeps a
    // (hypothetical) pre-v0.2 winner — deliberately skipped by the plugin —
    // from flapping forever (spec §10.2 measured zero such entries).
    const existingDifficulty = new Set(
      await deps.db.getExistingDifficultyBlockNumbers(winnerStrings),
    );
    const missingDifficulty: number[] = [];
    for (const n of winnerSet) {
      if (existingDifficulty.has(String(n)) || this.suppressedDifficulty.has(n)) continue;
      const misses = (this.difficultyMissCounts.get(n) ?? 0) + 1;
      this.difficultyMissCounts.set(n, misses);
      if (misses > 2) {
        this.suppressedDifficulty.add(n);
        console.warn(
          `[indexer] difficulty row for winner block ${n} still missing after re-walk (pre-v0.2 winner?); suppressing`,
        );
        continue;
      }
      missingDifficulty.push(n);
    }
    if (missingDifficulty.length > 0) {
      clean = false;
      deps.walker.enqueueDrift("W", missingDifficulty, "difficulty");
    }

    // authorship: sampled chunk counts against covered territory.
    clean = (await this.sampleAuthorship()) && clean;
    return clean;
  }

  private async sampleAuthorship(): Promise<boolean> {
    const { deps } = this;
    const authorship = deps.registry.find((p) => p.name === "authorship");
    if (!authorship) return true;
    const cov = deps.store.coverageFor("authorship");
    if (cov.low === null || cov.high === null) return true;
    const rng = deps.rng ?? Math.random;
    let clean = true;
    for (let i = 0; i < AUTHORSHIP_SAMPLE_CHUNKS; i++) {
      const span = cov.high - cov.low;
      const a = cov.low + Math.floor(rng() * Math.max(1, span - AUTHORSHIP_SAMPLE_WIDTH));
      const b = Math.min(cov.high, a + AUTHORSHIP_SAMPLE_WIDTH - 1);
      const key = `${a}-${b}`;
      if (this.suppressedAuthorshipChunks.has(key)) continue;
      // Only meaningful where the chunk is fully covered (no gaps inside).
      const holes = uncovered(cov, b).filter(([x, y]) => y >= a && x <= b);
      if (holes.length > 0) continue;
      const count = await deps.db.countAuthorshipBlocksInRange(String(a), String(b));
      if (count >= b - a + 1) continue;
      const misses = (this.authorshipChunkMissCounts.get(key) ?? 0) + 1;
      this.authorshipChunkMissCounts.set(key, misses);
      if (misses > 2) {
        this.suppressedAuthorshipChunks.add(key);
        console.warn(
          `[indexer] authorship chunk ${key} short (authorless blocks?); suppressing`,
        );
        continue;
      }
      clean = false;
      console.warn(`[indexer] coverage drift: authorship chunk ${key} short; re-enqueueing`);
      const blocks: number[] = [];
      for (let n = a; n <= b; n++) blocks.push(n);
      deps.walker.enqueueDrift("D", blocks, "authorship");
    }
    return clean;
  }

  /** Refresh the §11 backfill-progress observability (best-effort). */
  private publishProgress(): void {
    const { deps } = this;
    if (!deps.state) return;
    const coverage: NonNullable<
      NonNullable<typeof deps.state>["observability"]["indexer"]
    >["coverage"] = {};
    const enrichmentFloor = deps.enrichmentFloor?.() ?? null;
    for (const plugin of deps.registry) {
      const cov = deps.store.coverageFor(plugin.name);
      coverage[plugin.name] = {
        low: cov.low === null ? null : String(cov.low),
        high: cov.high === null ? null : String(cov.high),
        // Only failed/pending blocks — range completion keeps enumerated
        // non-winner numbers out of the gap list by construction (spec §7).
        gapBlocks: cov.gaps.reduce((sum, [a, b]) => sum + (b - a + 1), 0),
        prunedFloor: cov.prunedFloor === null ? null : String(cov.prunedFloor),
        topologyEnrichmentFloor:
          plugin.name === "winners" && enrichmentFloor !== null
            ? String(enrichmentFloor)
            : null,
        generation: cov.gen,
      };
    }
    const difficulty = deps.registry.find((p) => p.name === "difficulty");
    deps.state.observability.indexer = {
      backfillQueueDepth: deps.queue.totalDepth(),
      coverage,
      difficultyDataStartBlock: difficulty
        ? String(deps.store.coverageFor("difficulty").start)
        : null,
    };
  }

  /** Authorship read cutover, gated per spec §9.2 (never regressing). */
  private async maybeCutover(head: number): Promise<void> {
    const { deps } = this;
    if (!deps.registry.some((p) => p.name === "authorship")) return;
    if (await deps.db.isAuthorshipCutover()) return;
    const cov = deps.store.coverageFor("authorship");
    if (cov.low === null || cov.high === null) return;
    const floor = cov.prunedFloor === null ? cov.start : Math.max(cov.start, cov.prunedFloor);
    if (cov.gaps.length === 0 && cov.low <= floor && cov.high >= head) {
      await deps.db.tryAuthorshipCutover();
    }
  }
}
