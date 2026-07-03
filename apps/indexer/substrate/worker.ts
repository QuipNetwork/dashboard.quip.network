// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SubstrateWorker: connect → merge the collaborator streams + disconnect-as-
// error, wrapped in retry (reconnect + URL rotation) and takeUntil(abort).
// This class owns only the connect / reconnect / shutdown lifecycle; the
// per-concern streams live in `pipeline/` (spec §3). The per-connection
// composition in connection() is the unified indexer's assembly root:
// scheduler (L1) + dispatcher (L2) + registry plugins (L3), rebuilt from
// persisted coverage on every reconnect — cheap, and safe because every
// write is idempotent.

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import {
  Subject,
  type Observable,
  concatMap,
  defaultIfEmpty,
  defer,
  finalize,
  firstValueFrom,
  ignoreElements,
  merge,
  retry,
  startWith,
  takeUntil,
  tap,
  timer,
} from "rxjs";

import type { IndexerConfig } from "../core/config";
import { fromAbortSignal, fromDisconnect } from "../core/rx";
import type { IndexerState } from "../core/state";
import { type Worker, type WorkerContext, backoffMs, nowIso } from "../core/worker";
import { CoverageStore, DispatcherStream } from "../pipeline/dispatch";
import { buildRegistry, isBlockIndexable, isSnapshotIndexable } from "../pipeline/plugin";
import { BackfillWalker, Reconciler, TipEnqueuer } from "../pipeline/producers";
import { QueueCore } from "../pipeline/queue";
import { SnapshotScheduler } from "../pipeline/snapshots";
import { ChainHeadWriter } from "./chain-head";
import type { ChainClient, ConnectionStream } from "./ports";
import { CHAIN_HEAD_DEBOUNCE_DEFAULT_MS } from "./shared";

// Spec §13 default: per-lane backfill budget.
const BACKFILL_BLOCKS_PER_SEC = 5;
const TIP_QUIET_MS = 750;

export interface SubstrateWorkerDeps {
  config: IndexerConfig;
  // Round-robined on connect failure for endpoint fallback.
  urls: string[];
  // Builds a fresh client per connect attempt (each is bound to one URL).
  clientFactory: (url: string) => ChainClient;
  db: DatabaseAdapter;
  state: IndexerState;
  now?: () => number;
  chainHeadDebounceMs?: number;
}

export class SubstrateWorker implements Worker {
  private readonly ctx: WorkerContext;
  private readonly urls: string[];
  private readonly clientFactory: (url: string) => ChainClient;
  private readonly chainHeadDebounceMs: number;

  constructor(deps: SubstrateWorkerDeps) {
    this.ctx = {
      config: deps.config,
      db: deps.db,
      state: deps.state,
      now: deps.now ?? Date.now,
    };
    this.urls = deps.urls;
    this.clientFactory = deps.clientFactory;
    this.chainHeadDebounceMs = deps.chainHeadDebounceMs ?? CHAIN_HEAD_DEBOUNCE_DEFAULT_MS;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.urls.length === 0) {
      throw new Error("[indexer/substrate] urls list is empty; cannot connect");
    }

    let urlIdx = 0;
    let attempt = 0;
    // A clean drop of a healthy connection reconnects the SAME endpoint with a
    // short backoff; only a failed connect rotates URLs and grows the backoff.
    let connectedThisCycle = false;
    let failureLogged = false;

    const connection$ = defer(() => {
      connectedThisCycle = false;
      return this.connection(this.clientFactory(this.urls[urlIdx]!));
    }).pipe(
      tap(() => {
        connectedThisCycle = true;
        attempt = 0;
        failureLogged = false;
      }),
    );

    const run$ = connection$.pipe(
      retry({
        delay: (err) => {
          if (signal.aborted) throw err;
          if (connectedThisCycle) {
            attempt = 0;
          } else {
            if (!failureLogged) {
              console.warn(
                `[indexer/substrate] connection to ${this.urls[urlIdx]!} failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
              failureLogged = true;
            }
            urlIdx = (urlIdx + 1) % this.urls.length;
            attempt += 1;
          }
          return timer(backoffMs(attempt, this.ctx.config.substrateReconnectMaxBackoffMs));
        },
      }),
      takeUntil(fromAbortSignal(signal)),
    );

    try {
      await firstValueFrom(run$.pipe(ignoreElements(), defaultIfEmpty(undefined)));
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    }
  }

  private connection(client: ChainClient): Observable<"connected"> {
    // Per-connection composition root: collaborators are scoped to this
    // connection, with the client constructor-injected. Coverage cursors are
    // reloaded from meta, so scheduler state never leaks across connections.
    const { ctx } = this;
    const registry = buildRegistry(ctx.config, { now: ctx.now });
    const blockPlugins = registry.filter(isBlockIndexable);
    const snapshots = registry.filter(isSnapshotIndexable);
    const blockPluginNames = new Set(blockPlugins.map((p) => p.name));

    const wake$ = new Subject<void>();
    const wake = (): void => wake$.next();
    const queue = new QueueCore({
      backfillBlocksPerSec: BACKFILL_BLOCKS_PER_SEC,
      tipQuietMs: TIP_QUIET_MS,
      lastEventAtMs: () => {
        const iso = ctx.state.observability.lastSubstrateEventAt;
        if (!iso) return null;
        const ms = Date.parse(iso);
        return Number.isFinite(ms) ? ms : null;
      },
    });
    const store = new CoverageStore(ctx.db, ctx.now);
    // walker ↔ dispatcher wiring: range-completion records fold into
    // coverage minus the plugin's errored blocks (dispatcher stays the
    // single coverage writer, spec §5/§7).
    let dispatcher: DispatcherStream;
    const walker = new BackfillWalker({
      queue,
      wake,
      onRangeComplete: (r) =>
        store.foldRange(r.plugin, r.range[0], r.range[1], dispatcher.errorBlocksFor(r.plugin)),
    });
    dispatcher = new DispatcherStream({
      db: ctx.db,
      state: ctx.state,
      now: ctx.now,
      client,
      queue,
      wake$,
      walker,
      store,
      blockPlugins,
    });
    const reconciler = new Reconciler({
      db: ctx.db,
      client,
      queue,
      walker,
      store,
      registry: blockPlugins,
      now: ctx.now,
      once: ctx.config.once,
      // Under --once the deciding tick must land soon after the queue
      // drains — the 900s cadence would park the exit for 15 minutes.
      reconcileIntervalSec: ctx.config.once ? 2 : undefined,
      // §11 observability: each tick refreshes the backfill-progress field
      // the tip worker flushes to meta and /api/telemetry serves.
      state: ctx.state,
      enrichmentFloor: () => dispatcher.topologyEnrichmentFloor(),
    });

    const streams: readonly ConnectionStream[] = [
      new ChainHeadWriter(this.ctx, this.chainHeadDebounceMs, client),
      new TipEnqueuer(client, queue, wake, blockPluginNames),
      walker,
      reconciler,
      dispatcher,
      new SnapshotScheduler({
        client,
        db: ctx.db,
        state: ctx.state,
        config: ctx.config,
        snapshots,
        once: ctx.config.once,
      }),
    ];
    const merged$ = merge(...streams.map((s) => s.stream()), fromDisconnect(client)).pipe(
      startWith("connected" as const),
    );
    // The one deliberate lifecycle change beyond swapping stream contents
    // (spec §3/§7): under --once, the reconciler's done$ tears down the
    // never-completing siblings; retry({delay}) passes clean completion
    // through, so run() resolves without further edits.
    const gated$ = ctx.config.once ? merged$.pipe(takeUntil(reconciler.done$)) : merged$;

    return defer(() => client.connect()).pipe(
      tap(() => {
        this.ctx.state.observability.chainConnected = true;
        this.ctx.state.observability.lastSubstrateEventAt = nowIso(this.ctx);
      }),
      concatMap(() => gated$),
      finalize(() => {
        void client.disconnect().catch(() => {});
        this.ctx.state.observability.chainConnected = false;
      }),
    );
  }
}
