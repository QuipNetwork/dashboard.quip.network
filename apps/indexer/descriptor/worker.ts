// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DescriptorWorker: scans finalized `MinerRegistry.NodeDescriptors` snapshots
// written by operators running `quip-miner identify`. Same rxjs shape as the
// substrate worker — defer(connect) → drain merged with disconnect-as-error,
// wrapped in retry (reconnect + URL rotation) and takeUntil(abort) — but the
// per-connection body is a cursor *drain* rather than a subscription merge:
// `expand` walks checkpoint+1 → finalized head one block at a time, idling
// when caught up. It owns its own client lifecycle (independent of the
// canonical block writer) so a descriptor-side drop doesn't disturb blocks
// and vice versa.

import {
  type Observable,
  catchError,
  concatMap,
  defaultIfEmpty,
  defer,
  expand,
  finalize,
  firstValueFrom,
  from,
  ignoreElements,
  map,
  merge,
  of,
  retry,
  takeUntil,
  throwError,
  timer,
} from "rxjs";

import type { IndexerConfig } from "../core/config";
import { type Disconnectable, fromAbortSignal, fromDisconnect } from "../core/rx";
import type { IndexerState } from "../core/state";
import type { UnsubFn } from "../substrate-client";
import { type Worker, type WorkerContext } from "../core/worker";
import {
  type DescriptorIterationDeps,
  type DescriptorReadSource,
  isPrunedStateError,
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
  // as the upper bound of work to do. Substrate-worker is the sole writer of
  // that field; we never mutate it.
  state: IndexerState;
  // Test hook for deterministic observedAt timestamps.
  now?: () => number;
  // Wait when caught up to the head. Short enough to feel responsive on a
  // healthy chain, long enough not to hot-spin.
  idlePollMs?: number;
  // Backoff after a per-block RPC error, a not-yet-on-chain block, or a failed
  // connect. Substrate-worker handles connection recovery; we just slow our
  // scan so a transient failure doesn't flood the logs.
  errorBackoffMs?: number;
}

const IDLE_POLL_MS_DEFAULT = 2000;
const ERROR_BACKOFF_MS_DEFAULT = 2000;

export class DescriptorWorker implements Worker {
  private readonly config: IndexerConfig;
  private readonly db: WorkerContext["db"];
  private readonly state: IndexerState;
  private readonly urls: string[];
  private readonly clientFactory: (url: string) => DescriptorSource;
  private readonly now?: () => number;
  private readonly idlePollMs: number;
  private readonly errorBackoffMs: number;

  constructor(deps: DescriptorWorkerDeps) {
    this.config = deps.config;
    this.db = deps.db;
    this.state = deps.state;
    this.urls = deps.urls;
    this.clientFactory = deps.clientFactory;
    this.now = deps.now;
    this.idlePollMs = deps.idlePollMs ?? IDLE_POLL_MS_DEFAULT;
    this.errorBackoffMs = deps.errorBackoffMs ?? ERROR_BACKOFF_MS_DEFAULT;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.urls.length === 0) {
      throw new Error("[indexer/descriptor] urls list is empty; cannot connect");
    }
    console.log(`[indexer/descriptor] starting scan from block ${await this.initialCursor()}`);

    let urlIdx = 0;
    const run$ = defer(() => this.session(this.clientFactory(this.urls[urlIdx]!), this.urls[urlIdx]!)).pipe(
      retry({
        delay: (err) => {
          if (signal.aborted) throw err;
          // Both a failed connect and a dropped connection rotate to the next
          // endpoint before backing off.
          urlIdx = (urlIdx + 1) % this.urls.length;
          return timer(this.errorBackoffMs);
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

  // One connection: connect → drain merged with disconnect-as-error → always
  // disconnect on teardown. A failed connect or a drop errors the stream so
  // the outer retry rotates and reconnects.
  private session(client: DescriptorSource, url: string): Observable<bigint> {
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
      concatMap(() => merge(this.drain(iterDeps, client), fromDisconnect(client))),
      finalize(() => {
        void client.disconnect().catch(() => {});
      }),
    );
  }

  // Walk checkpoint+1 → finalized head one block at a time. `expand` re-feeds
  // each computed cursor back into `step`, so the recursion IS the loop; it
  // never completes on its own (only a drop or abort tears it down).
  private drain(iterDeps: DescriptorIterationDeps, client: DescriptorSource): Observable<bigint> {
    return defer(() => from(this.initialCursor())).pipe(
      expand((cursor) => this.step(iterDeps, client, cursor)),
    );
  }

  // Decide the next cursor: idle when caught up, advance on a processed block,
  // skip a pruned block, and back off (retrying the same block) on a transient
  // error or a block that isn't on chain yet.
  private step(
    iterDeps: DescriptorIterationDeps,
    client: DescriptorSource,
    cursor: bigint,
  ): Observable<bigint> {
    const finalizedNum = parseBigIntOrNull(this.state.observability.finalizedBlockHeight);
    if (finalizedNum === null || cursor > finalizedNum) {
      return timer(this.idlePollMs).pipe(map(() => cursor));
    }
    return from(runDescriptorIteration(iterDeps, cursor.toString())).pipe(
      concatMap((advanced) =>
        advanced ? of(cursor + 1n) : timer(this.errorBackoffMs).pipe(map(() => cursor)),
      ),
      catchError((e) => {
        if (isPrunedStateError(e)) {
          console.warn(`[indexer/descriptor] block ${cursor} state pruned; skipping`);
          return from(this.db.setDescriptorCheckpoint(cursor.toString())).pipe(
            map(() => cursor + 1n),
          );
        }
        console.warn(
          `[indexer/descriptor] block ${cursor} scan failed:`,
          e instanceof Error ? e.message : e,
        );
        // A drop can surface as an RPC error before onDisconnected fires; if
        // the socket is gone, error out so the outer retry rotates + reconnects
        // instead of hammering the same block on a dead client. Otherwise the
        // failure is transient — back off and retry the same block.
        return timer(this.errorBackoffMs).pipe(
          concatMap(() => (client.isConnected() ? of(cursor) : throwError(() => e))),
        );
      }),
    );
  }

  // The next block to process. Resumes from the persisted checkpoint (the
  // highest successfully processed block) so a reconnect picks up where the
  // last connection left off; falls back to the configured start otherwise.
  // A CHAIN block number, not an array index — 1 is the first post-genesis
  // block on substrate.
  private async initialCursor(): Promise<bigint> {
    const checkpoint = await this.db.getDescriptorCheckpoint();
    let cursor =
      checkpoint !== null ? BigInt(checkpoint) + 1n : BigInt(this.config.descriptorStartBlock);
    if (cursor < 1n) cursor = 1n;
    return cursor;
  }
}

function parseBigIntOrNull(s: string | null): bigint | null {
  if (s === null) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}
