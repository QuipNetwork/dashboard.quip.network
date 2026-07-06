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
  EMPTY,
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
  throwError,
  timeout,
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
import { SyncGate } from "./sync-gate";

// Spec §13 default: per-lane backfill budget.
const BACKFILL_BLOCKS_PER_SEC = 5;
const TIP_QUIET_MS = 750;

// Liveness watchdog: the whole self-heal path hinges on the provider's
// "disconnected" event firing (fromDisconnect → retry → reconnect). A clean
// server-side WS close (code 1000) at the tip can leave that event unfired or
// the reconnect's connect() hung half-open, silently parking every
// subscription. The watchdog is the backstop: if no substrate head has landed
// for HEAD_LIVENESS_STALE_MS, error the stream so the existing retry rebuilds
// the connection. Heads arrive every ~6s (BABE slot), so 90s ≈ 15 missed slots.
const HEAD_LIVENESS_STALE_MS = 90_000;
const HEAD_LIVENESS_POLL_MS = 15_000;
// Upper bound on establishing a connection (provider.connect + ApiPromise
// metadata handshake). The WsProvider timeout is per-request only and does not
// cover a half-open connect, so a flooded/idle endpoint could hang forever.
const CONNECT_TIMEOUT_MS = 30_000;

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
  // Sync-gate poll cadence overrides (tests shrink them).
  syncGatePollMs?: { syncing?: number; synced?: number };
  // Liveness watchdog + connect-timeout overrides (tests shrink them).
  headLivenessMs?: number;
  headLivenessPollMs?: number;
  connectTimeoutMs?: number;
}

export class SubstrateWorker implements Worker {
  private readonly ctx: WorkerContext;
  private readonly urls: string[];
  private readonly clientFactory: (url: string) => ChainClient;
  private readonly chainHeadDebounceMs: number;
  private readonly syncGatePollMs?: { syncing?: number; synced?: number };
  private readonly headLivenessMs: number;
  private readonly headLivenessPollMs: number;
  private readonly connectTimeoutMs: number;

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
    this.syncGatePollMs = deps.syncGatePollMs;
    this.headLivenessMs = deps.headLivenessMs ?? HEAD_LIVENESS_STALE_MS;
    this.headLivenessPollMs = deps.headLivenessPollMs ?? HEAD_LIVENESS_POLL_MS;
    this.connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  // Backstop for a silently-dead connection: poll lastSubstrateEventAt and, if
  // no head has landed within the liveness window, error the stream so the
  // worker's retry rebuilds the connection (reconnect + full re-subscribe).
  private livenessWatchdog(): Observable<never> {
    const staleMs = this.headLivenessMs;
    return timer(this.headLivenessPollMs, this.headLivenessPollMs).pipe(
      concatMap(() => {
        const iso = this.ctx.state.observability.lastSubstrateEventAt;
        const last = iso ? Date.parse(iso) : NaN;
        if (Number.isFinite(last) && this.ctx.now() - last > staleMs) {
          return throwError(
            () => new Error(`no substrate head for ${staleMs}ms (last ${iso}); forcing reconnect`),
          );
        }
        return EMPTY;
      }),
      ignoreElements(),
    );
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

    // Sync gate (design 2026-07-04): pause-in-place while the validator is
    // in major sync. Consulted by the queue, reconciler, and snapshot
    // scheduler; chain-head + tip subscriptions stay live so the dashboard
    // shows sync progress.
    const syncGate = new SyncGate({
      client,
      state: ctx.state,
      syncingPollMs: this.syncGatePollMs?.syncing,
      syncedPollMs: this.syncGatePollMs?.synced,
      onResume: wake,
    });

    const queue = new QueueCore({
      backfillBlocksPerSec: BACKFILL_BLOCKS_PER_SEC,
      tipQuietMs: TIP_QUIET_MS,
      gated: () => syncGate.gated(),
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
      gated: () => syncGate.gated(),
      resume$: syncGate.resumed$,
    });

    const streams: readonly ConnectionStream[] = [
      syncGate,
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
        gated: () => syncGate.gated(),
        resume$: syncGate.resumed$,
      }),
    ];
    const merged$ = merge(
      ...streams.map((s) => s.stream()),
      fromDisconnect(client),
      this.livenessWatchdog(),
    ).pipe(startWith("connected" as const));
    // The one deliberate lifecycle change beyond swapping stream contents
    // (spec §3/§7): under --once, the reconciler's done$ tears down the
    // never-completing siblings; retry({delay}) passes clean completion
    // through, so run() resolves without further edits.
    const gated$ = ctx.config.once ? merged$.pipe(takeUntil(reconciler.done$)) : merged$;

    return defer(() => client.connect()).pipe(
      // A half-open connect (WS handshake ok, metadata never returns) would
      // otherwise hang here forever; bound it so retry can rotate/reconnect.
      timeout({ first: this.connectTimeoutMs }),
      tap(() => {
        this.ctx.state.observability.chainConnected = true;
        this.ctx.state.observability.lastSubstrateEventAt = nowIso(this.ctx);
      }),
      // Prime the sync gate BEFORE the pipeline subscribes, so a validator
      // in major sync is detected at startup rather than racing the
      // reconciler's boot tick. check() swallows RPC errors (gate stays
      // open), so this cannot fail the connection.
      concatMap(() => syncGate.check()),
      concatMap(() => gated$),
      finalize(() => {
        void client.disconnect().catch(() => {});
        this.ctx.state.observability.chainConnected = false;
      }),
    );
  }
}
