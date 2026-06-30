// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DescriptorWorker: snapshots the finalized `MinerRegistry.NodeDescriptors`
// storage written by operators running `quip-miner identify`. Same rxjs shape
// as the substrate worker — defer(connect) → loop merged with
// disconnect-as-error, wrapped in retry (reconnect + URL rotation) and
// takeUntil(abort) — but the per-connection body is a cadence-driven snapshot
// of the registry at the finalized head, not a per-block walk.
//
// Each registry entry carries its own on-chain `updatedAt` provenance, and
// `node_descriptors` is keyed by account (latest-per-account, not a history
// table), so one read at the finalized head yields exactly what walking every
// block from genesis would converge to — at O(nodes) per poll instead of
// O(blocks × nodes). It owns its own client lifecycle (independent of the
// canonical block writer) so a descriptor-side drop doesn't disturb blocks.

import {
  type Observable,
  catchError,
  concatMap,
  defaultIfEmpty,
  defer,
  exhaustMap,
  finalize,
  firstValueFrom,
  from,
  ignoreElements,
  merge,
  retry,
  takeUntil,
  timer,
} from "rxjs";

import type { IndexerConfig } from "../core/config";
import { type Disconnectable, fromAbortSignal, fromDisconnect } from "../core/rx";
import type { IndexerState } from "../core/state";
import type { UnsubFn } from "../clients/substrate-client";
import { type Worker, type WorkerContext } from "../core/worker";
import {
  type DescriptorIterationDeps,
  type DescriptorReadSource,
  runDescriptorIteration,
} from "./iteration";

// Connect/lifecycle slice the worker drives, plus the read slice the iteration
// uses. Satisfied structurally by SubstrateClient and FakeSubstrateClient.
export interface DescriptorSource extends DescriptorReadSource, Disconnectable {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  onDisconnected(cb: () => void): UnsubFn;
}

export interface DescriptorWorkerDeps {
  config: IndexerConfig;
  db: WorkerContext["db"];
  urls: string[];
  clientFactory: (url: string) => DescriptorSource;
  // Shared with substrate-worker — we read `observability.finalizedBlockHeight`
  // as the block to snapshot the registry at. Substrate-worker is the sole
  // writer of that field; we never mutate it.
  state: IndexerState;
  // Test hook for deterministic observedAt timestamps.
  now?: () => number;
  // Cadence between finalized-head registry snapshots. Short enough to feel
  // responsive on a healthy chain, long enough not to hammer the node.
  scanIntervalMs?: number;
}

const SCAN_INTERVAL_MS_DEFAULT = 2000;

// Consecutive live-connection scan failures before we stop treating them as
// transient and escalate to a loud, actionable error. A schema drift (e.g. a
// `node_descriptors` column mismatch) fails identically on every tick, so the
// registry silently freezes on stale rows; this threshold turns that into an
// unmistakable alarm instead of an endless stream of warnings.
const PERSISTENT_FAILURE_THRESHOLD = 3;

export class DescriptorWorker implements Worker {
  private readonly db: WorkerContext["db"];
  private readonly state: IndexerState;
  private readonly urls: string[];
  private readonly clientFactory: (url: string) => DescriptorSource;
  private readonly now?: () => number;
  private readonly scanIntervalMs: number;
  // Consecutive scan failures on a live connection (reset on any success).
  private consecutiveFailures = 0;

  constructor(deps: DescriptorWorkerDeps) {
    this.db = deps.db;
    this.state = deps.state;
    this.urls = deps.urls;
    this.clientFactory = deps.clientFactory;
    this.now = deps.now;
    this.scanIntervalMs = deps.scanIntervalMs ?? SCAN_INTERVAL_MS_DEFAULT;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.urls.length === 0) {
      throw new Error("[indexer/descriptor] urls list is empty; cannot connect");
    }
    console.log("[indexer/descriptor] starting finalized-head registry snapshots");

    let urlIdx = 0;
    const run$ = defer(() =>
      this.session(this.clientFactory(this.urls[urlIdx]!), this.urls[urlIdx]!),
    ).pipe(
      retry({
        delay: (err) => {
          if (signal.aborted) throw err;
          // Both a failed connect and a dropped connection rotate to the next
          // endpoint before backing off.
          urlIdx = (urlIdx + 1) % this.urls.length;
          return timer(this.scanIntervalMs);
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

  // One connection: connect → scan loop merged with disconnect-as-error →
  // always disconnect on teardown. A failed connect or a drop errors the
  // stream so the outer retry rotates and reconnects.
  private session(client: DescriptorSource, url: string): Observable<unknown> {
    const iterDeps: DescriptorIterationDeps = {
      client,
      db: this.db,
      ...(this.now !== undefined ? { now: this.now } : {}),
    };
    const connect$ = defer(() => from(client.connect())).pipe(
      catchError((e) => {
        console.warn(
          `[indexer/descriptor] connect to ${url} failed: ${e instanceof Error ? e.message : e}`,
        );
        throw e;
      }),
    );
    return connect$.pipe(
      concatMap(() => merge(this.scanLoop(iterDeps, client), fromDisconnect(client))),
      finalize(() => {
        void client.disconnect().catch(() => {});
      }),
    );
  }

  // timer(0, interval) → exhaustMap(scan): the leading 0 fires once on connect;
  // exhaustMap drops a tick rather than overlapping a still-running scan.
  private scanLoop(
    iterDeps: DescriptorIterationDeps,
    client: DescriptorSource,
  ): Observable<unknown> {
    return timer(0, this.scanIntervalMs).pipe(
      exhaustMap(() => from(this.scanHead(iterDeps, client))),
    );
  }

  // Snapshot the registry at the current finalized head. Idle when the head is
  // unknown (substrate-worker hasn't connected yet). A scan error on a dead
  // socket tears the session down so the outer retry rotates + reconnects; a
  // transient error on a live connection is logged and retried next tick.
  private async scanHead(
    iterDeps: DescriptorIterationDeps,
    client: DescriptorSource,
  ): Promise<void> {
    const head = this.state.observability.finalizedBlockHeight;
    if (head === null) return;
    try {
      await runDescriptorIteration(iterDeps, head);
      this.consecutiveFailures = 0;
    } catch (e) {
      if (!client.isConnected()) throw e;
      // A live connection but a failing iteration means the write side, not the
      // socket, is broken. Count consecutive failures: the first few are logged
      // as transient warnings, but a persistent run is almost always a schema
      // drift (the registry then silently freezes on stale descriptors), so we
      // escalate to an actionable error rather than keep serving stale data
      // quietly.
      this.consecutiveFailures += 1;
      const detail = e instanceof Error ? e.message : String(e);
      if (this.consecutiveFailures >= PERSISTENT_FAILURE_THRESHOLD) {
        console.error(
          `[indexer/descriptor] head ${head} scan has failed ${this.consecutiveFailures} times in a row: ${detail}. ` +
            "The connection is live, so this is a write-side fault (e.g. a node_descriptors schema " +
            "drift, or a DB error). The registry is now serving STALE descriptors. Check the error " +
            "above; if it is a missing/mismatched column, verify migrations applied (see migration 0004).",
        );
      } else {
        console.warn(`[indexer/descriptor] head ${head} scan failed: ${detail}`);
      }
    }
  }
}
