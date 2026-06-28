// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SubstrateWorker: the canonical block writer. Connect → merge the collaborator
// streams + disconnect-as-error, wrapped in retry (reconnect + URL rotation)
// and takeUntil(abort). This class owns only the connect / reconnect / shutdown
// lifecycle; the per-concern streams live in sibling modules.

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import {
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
import { BlockPipeline } from "./blocks";
import { ChainHeadWriter } from "./chain-head";
import { PollScheduler } from "./polls";
import type { ChainClient, ConnectionStream } from "./ports";
import { CHAIN_HEAD_DEBOUNCE_DEFAULT_MS } from "./shared";

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
    // connection, with the client constructor-injected.
    const streams: readonly ConnectionStream[] = [
      new ChainHeadWriter(this.ctx, this.chainHeadDebounceMs, client),
      new BlockPipeline(this.ctx, client),
      new PollScheduler(this.ctx, client),
    ];
    return defer(() => client.connect()).pipe(
      tap(() => {
        this.ctx.state.observability.chainConnected = true;
        this.ctx.state.observability.lastSubstrateEventAt = nowIso(this.ctx);
      }),
      concatMap(() =>
        merge(...streams.map((s) => s.stream()), fromDisconnect(client)).pipe(
          startWith("connected" as const),
        ),
      ),
      finalize(() => {
        void client.disconnect().catch(() => {});
        this.ctx.state.observability.chainConnected = false;
      }),
    );
  }
}
