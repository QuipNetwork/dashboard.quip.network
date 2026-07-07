// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L2 (spec §6): the queue driver, the per-item dispatcher, and the buffered
// coverage flusher. The block is fetched ONCE per item; plugins share
// memoized lazy reads. Each plugin runs inside its own catch — a throw
// withholds coverage for that block for that plugin only (it lands in the
// plugin's gap list at the next flush) while siblings advance. The
// dispatcher is the single coverage WRITER: item completions fold here, and
// the walker's range-completion records fold here (minus the plugin's
// errored blocks), keeping coverage honest.

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import {
  EMPTY,
  Subject,
  concat,
  concatMap,
  defer,
  from,
  ignoreElements,
  merge,
  mergeMap,
  of,
  partition,
  share,
  startWith,
  switchMap,
  timer,
  type Observable,
} from "rxjs";

import { StatePrunedError } from "../clients/substrate-client/errors";
import type {
  BlockEvents,
  QBlockInfo,
  QBlockParticipant,
  TopologyInfo,
} from "../clients/substrate-client";
import type { IndexerState } from "../core/state";
import type { ChainClient, ConnectionStream } from "../substrate/ports";
import {
  coverRange,
  emptyCoverage,
  parseCoverage,
  raisePrunedFloor,
  reprobePrunedFloor,
  serializeCoverage,
  type Coverage,
} from "./coverage";
import type { BlockContext, BlockIndexable } from "./plugin";
import type { CoverageAccess } from "./producers";
import type { QueueCore, WorkItem } from "./queue";

const FLUSH_EVERY_COMPLETIONS = 100;
const FLUSH_INTERVAL_MS = 5_000;
const BACKFILL_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// CoverageStore — the dispatcher-owned in-memory coverage + flusher

export class CoverageStore implements CoverageAccess {
  private readonly entries = new Map<string, { cov: Coverage; gen: number; dirty: boolean }>();
  private readonly startCache = new Map<string, number>();
  private completionsSinceFlush = 0;

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => number,
  ) {}

  async ensureLoaded(plugin: BlockIndexable, client: ChainClient): Promise<void> {
    if (this.entries.has(plugin.name)) return;
    const gen = await this.db.getIndexerGeneration(plugin.name);
    let start = this.startCache.get(plugin.name);
    if (start === undefined) {
      start = await plugin.startBlock(client);
      this.startCache.set(plugin.name, start);
    }
    const raw = await this.db.getCoverage(plugin.name);
    let cov: Coverage | null = null;
    if (raw !== null) {
      try {
        cov = parseCoverage(JSON.parse(raw));
      } catch {
        cov = null; // malformed → empty re-walk; idempotent writes make it safe
      }
    }
    // A persisted row from a pre-reindex generation is dropped coverage.
    if (cov === null || cov.gen !== gen) cov = emptyCoverage(gen, start);
    this.entries.set(plugin.name, { cov, gen, dirty: false });
  }

  coverageFor(name: string): Coverage {
    const e = this.entries.get(name);
    if (!e) throw new Error(`coverage not loaded for plugin "${name}"`);
    return e.cov;
  }

  foldItem(name: string, block: number): void {
    const e = this.entries.get(name);
    if (!e) return;
    e.cov = coverRange(e.cov, block, block);
    e.dirty = true;
    this.completionsSinceFlush++;
  }

  /** Fold a range-completion record, excluding the plugin's errored blocks. */
  foldRange(name: string, a: number, b: number, exclude: ReadonlySet<number>): void {
    const e = this.entries.get(name);
    if (!e) return;
    let runStart = a;
    for (let n = a; n <= b + 1; n++) {
      if (n <= b && !exclude.has(n)) continue;
      if (runStart < n) e.cov = coverRange(e.cov, runStart, n - 1);
      runStart = n + 1;
    }
    e.dirty = true;
  }

  raiseFloor(name: string, floor: number): void {
    const e = this.entries.get(name);
    if (!e) return;
    e.cov = raisePrunedFloor(e.cov, floor);
    e.dirty = true;
  }

  /** Boot re-probe succeeded: archive rotation made the depth readable. */
  clearFloor(name: string): void {
    const e = this.entries.get(name);
    if (!e || e.cov.prunedFloor === null) return;
    e.cov = reprobePrunedFloor(e.cov, null);
    e.dirty = true;
  }

  /** Buffered flush: every 100 completions (caller) or 5s (driver timer). */
  async maybeFlush(): Promise<void> {
    if (this.completionsSinceFlush >= FLUSH_EVERY_COMPLETIONS) await this.flush();
  }

  async flush(): Promise<void> {
    this.completionsSinceFlush = 0;
    let flushedAuthorship = false;
    for (const [name, e] of this.entries) {
      if (!e.dirty) continue;
      const json = serializeCoverage(e.cov, new Date(this.now()).toISOString());
      const ok = await this.db.setCoverageIfGeneration(name, e.gen, json);
      if (!ok) {
        // Reindex raced us: this generation is dead. Drop the entry so the
        // next ensureLoaded reloads fresh (spec §7 write protocol).
        console.warn(`[pipeline] coverage flush for "${name}" dropped (stale generation)`);
        this.entries.delete(name);
        continue;
      }
      e.dirty = false;
      if (name === "authorship") flushedAuthorship = true;
    }
    // Post-cutover the summary cache rides the same flush cadence (§9.2).
    if (flushedAuthorship && (await this.db.isAuthorshipCutover())) {
      await this.db.recomputeAuthorshipSummary();
    }
  }
}

// ---------------------------------------------------------------------------
// DispatcherStream — driver + per-item processing

export interface DispatcherDeps {
  db: DatabaseAdapter;
  state: IndexerState;
  now: () => number;
  client: ChainClient;
  queue: QueueCore;
  wake$: Subject<void>;
  walker: { notifyCompleted(block: number): void };
  store: CoverageStore;
  blockPlugins: BlockIndexable[];
  backfillConcurrency?: number;
  flushIntervalMs?: number;
}

export class DispatcherStream implements ConnectionStream {
  private readonly byName: Map<string, BlockIndexable>;
  // Names of the winner-domain plugins. An item whose entire `pending` set is
  // drawn from here is a "winner-only" item (winner backfill, never the tip —
  // tip winner blocks also carry the every-block authorship plugin) and takes
  // the targeted `decodeWinnerBlock` path instead of the full block fetch.
  private readonly winnerDomainNames: Set<string>;
  // Blocks whose onBlock threw, per plugin — excluded from range folds so
  // range completion can never paper over a real failure.
  private readonly errorBlocks = new Map<string, Set<number>>();
  private topologyMemo: Promise<TopologyInfo> | null = null;
  // Shallowest (highest) block whose enrichment reads degraded under pruning
  // (spec §8 cases 1-2) — reported via observability as "full enrichment
  // from block N+1".
  private enrichmentFloor: number | null = null;
  private loggedPrunedFloor = false;

  constructor(private readonly deps: DispatcherDeps) {
    this.byName = new Map(deps.blockPlugins.map((p) => [p.name, p]));
    this.winnerDomainNames = new Set(
      deps.blockPlugins.filter((p) => p.domain === "winner-blocks").map((p) => p.name),
    );
  }

  /** An item every one of whose pending plugins is winner-domain. */
  private isWinnerOnly(pending: ReadonlySet<string>): boolean {
    if (pending.size === 0) return false;
    for (const name of pending) if (!this.winnerDomainNames.has(name)) return false;
    return true;
  }

  errorBlocksFor(plugin: string): ReadonlySet<number> {
    return this.errorBlocks.get(plugin) ?? new Set();
  }

  topologyEnrichmentFloor(): number | null {
    return this.enrichmentFloor;
  }

  stream(): Observable<never> {
    const item$ = this.deps.wake$.pipe(
      startWith(undefined),
      switchMap(() => this.drain$()),
      share(),
    );
    const [tip$, backfill$] = partition(item$, (i) => i.source === "tip");
    const flushMs = this.deps.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    return merge(
      // Strict block order at the tip (today's live-pipeline discipline);
      // unordered completion is safe for backfill — coverage is order-free.
      tip$.pipe(concatMap((i) => from(this.process(i)))),
      backfill$.pipe(
        mergeMap(
          (i) => from(this.process(i)),
          this.deps.backfillConcurrency ?? BACKFILL_CONCURRENCY,
        ),
      ),
      timer(flushMs, flushMs).pipe(concatMap(() => from(this.deps.store.flush()))),
    ).pipe(ignoreElements());
  }

  /** Pull until "empty" (sleep till next wake), honoring retryAtMs sleeps. */
  private drain$(): Observable<WorkItem> {
    return defer((): Observable<WorkItem> => {
      const r = this.deps.queue.tryPull(this.deps.now());
      if (r === "empty") return EMPTY;
      if ("retryAtMs" in (r as { retryAtMs: number })) {
        const delay = Math.max(0, (r as { retryAtMs: number }).retryAtMs - this.deps.now());
        return timer(delay).pipe(switchMap(() => this.drain$()));
      }
      return concat(of(r as WorkItem), this.drain$());
    });
  }

  private async process(item: WorkItem): Promise<void> {
    const { deps } = this;
    const block = item.block;
    try {
      // ONE block fetch per item, shared by every plugin (spec §6). Winner-only
      // backfill items take the targeted decode: events from system.events.at
      // plus a SINGLE winning_solution fetch (reused below for ctx.qblock and
      // the solution-carried topologyHash), skipping derive.chain.getBlock. The
      // tip/full path keeps the full decode — authorship at the tip needs the
      // author + full events.
      const winnerOnly = this.isWinnerOnly(item.pending);
      let events: BlockEvents | null;
      // The winner path's single QBlockInfo, threaded onto ctx below so no
      // second winningSolution call is ever issued for a winner block.
      let winnerQblock: QBlockInfo | null = null;
      try {
        if (winnerOnly) {
          const decoded = await deps.client.decodeWinnerBlock(String(block));
          events = decoded?.events ?? null;
          winnerQblock = decoded?.qblock ?? null;
        } else {
          events = await deps.client.processFinalizedBlock(String(block));
        }
      } catch (err) {
        if (err instanceof StatePrunedError) {
          // Case 3 (spec §8): the block cannot be indexed for ANY plugin
          // that needed it. Ratchet each pending plugin's floor; the block
          // is NOT marked covered — coverage never lies about what was
          // indexed. The walker stops descending past the floor.
          for (const name of item.pending) deps.store.raiseFloor(name, block);
          if (!this.loggedPrunedFloor) {
            this.loggedPrunedFloor = true;
            console.warn(
              `[pipeline] state pruned at block #${block}; flooring backfill (archive node recommended)`,
            );
          }
          return;
        }
        console.warn(`[pipeline] block #${block}: block decode failed:`, err);
        return;
      }
      if (events === null) return; // nothing marked covered; reconciler re-detects

      // Pruned ENRICHMENT reads degrade in place (spec §8 cases 1-2):
      // indexing what is visible beats holding history hostage to one
      // enrichment. The shallowest degraded block is reported.
      const degradeEnrichment = (n: number): void => {
        this.enrichmentFloor =
          this.enrichmentFloor === null ? n : Math.max(this.enrichmentFloor, n);
      };

      let qblockMemo: Promise<QBlockInfo | null> | null = null;
      let lastProofMemo: Promise<number> | null = null;
      let topoAtMemo: Promise<string | null> | null = null;
      let participantsMemo: Promise<QBlockParticipant[]> | null = null;
      const ctx: BlockContext = {
        number: block,
        source: item.source,
        events,
        // Winner path: reuse the QBlockInfo decodeWinnerBlock already fetched
        // (its single winningSolution call) — never a second runtime call. The
        // tip/full path lazily fetches on first read exactly as before.
        qblock: () =>
          winnerOnly
            ? Promise.resolve(winnerQblock)
            : (qblockMemo ??= deps.client.getQBlock(String(block)).catch(() => null)),
        lastProofBlockAtParent: () =>
          (lastProofMemo ??= deps.client.getLastProofBlockAt(events.parentHash).catch((err) => {
            if (err instanceof StatePrunedError) {
              // Case 2: the parent is one block deeper — degrade to the
              // existing lastProofBlock ≤ 0 → miningTime 0 path.
              degradeEnrichment(block);
              return 0;
            }
            throw err;
          })),
        // Winner path: the solution already carries the mined-against topology
        // hash, so stamp from it — no per-block historical DefaultTopology.at
        // runtime read. Tip items resolve live (mid-connection topology switches
        // re-tag immediately, blocks.ts:181); other backfill items read the true
        // historical value (spec §6).
        defaultTopologyAt: () =>
          (topoAtMemo ??= winnerOnly
            ? Promise.resolve(winnerQblock?.topologyHash ?? null)
            : item.source === "tip"
              ? Promise.resolve(deps.state.defaultTopologyHash)
              : deps.client.getDefaultTopologyAt(String(block)).catch((err) => {
                  if (err instanceof StatePrunedError) {
                    // Case 1: topology_hash null matches the live path's
                    // fallback discipline (blocks.ts:181).
                    degradeEnrichment(block);
                    return null;
                  }
                  throw err;
                })),
        topology: () => this.topology(),
        // Keyed by the winner's qblock id — non-winner blocks have none, so
        // resolve empty without a chain call. Failures degrade to [] (the
        // participation plugin then no-ops) rather than failing the block.
        participants: () =>
          (participantsMemo ??= events.winner
            ? deps.client.getQBlockParticipants(events.winner.qblockId).catch(() => [])
            : Promise.resolve<QBlockParticipant[]>([])),
      };

      for (const name of item.pending) {
        const plugin = this.byName.get(name);
        if (!plugin) continue;
        try {
          await plugin.onBlock(ctx, deps.db);
          deps.store.foldItem(name, block);
          if (name === "winners" && events.winner !== null) {
            deps.state.observability.lastBlockInsertAt = new Date(deps.now()).toISOString();
          }
        } catch (err) {
          // Isolation: this plugin's gap; siblings advance (spec §6).
          console.warn(`[pipeline] plugin "${name}" failed on block #${block}:`, err);
          let set = this.errorBlocks.get(name);
          if (!set) this.errorBlocks.set(name, (set = new Set()));
          set.add(block);
        }
      }
      if (item.source === "tip") {
        deps.state.observability.lastSubstrateEventAt = new Date(deps.now()).toISOString();
      }
    } finally {
      deps.queue.complete(block);
      // Whichever bucket served it, the block counts toward lane-W chunk
      // tracking (range records fold via the wired onRangeComplete).
      deps.walker.notifyCompleted(block);
      await deps.store.maybeFlush();
    }
  }

  /** Primed once per connection with the {0,0} fallback (blocks.ts:207-217). */
  private topology(): Promise<TopologyInfo> {
    return (this.topologyMemo ??= this.deps.client
      .getTopology()
      .catch(() => null)
      .then((t) => t ?? { nodeCount: 0, edgeCount: 0 }));
  }
}
