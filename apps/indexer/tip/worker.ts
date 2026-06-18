// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TipWorker: poll the co-located miner's REST surface on a fixed cadence.
// timer(0, interval) → exhaustMap(iterate) → takeUntil(abort). The leading 0
// runs once immediately; exhaustMap drops a tick rather than overlapping a
// still-running iteration. `once` mode runs a single iteration and returns.

import {
  defaultIfEmpty,
  exhaustMap,
  firstValueFrom,
  ignoreElements,
  takeUntil,
  timer,
} from "rxjs";

import { resolveSelfMinerRestUrl } from "@quip/core/resolve-miner-rest";

import type { ChainStateReader } from "../core/chain-state";
import type { IndexerConfig } from "../core/config";
import type { MinerSource } from "../miner-client";
import { fromAbortSignal, runEffect } from "../core/rx";
import type { IndexerState } from "../core/state";
import { type Worker, type WorkerContext, nowIso } from "../core/worker";
import { runTipIteration } from "./iteration";

export interface TipWorkerDeps {
  config: IndexerConfig;
  db: WorkerContext["db"];
  state: IndexerState;
  // Factory pattern keeps production wiring (`new QuipClient(...)`) and test
  // wiring (a pre-canned fake) symmetric.
  clientFactory: (baseUrl: string) => MinerSource;
  chainState: ChainStateReader;
  now?: () => number;
}

export class TipWorker implements Worker {
  private readonly ctx: WorkerContext;
  private readonly clientFactory: (baseUrl: string) => MinerSource;
  private readonly chainState: ChainStateReader;

  constructor(deps: TipWorkerDeps) {
    this.ctx = {
      config: deps.config,
      db: deps.db,
      state: deps.state,
      now: deps.now ?? Date.now,
    };
    this.clientFactory = deps.clientFactory;
    this.chainState = deps.chainState;
  }

  async run(signal: AbortSignal): Promise<void> {
    const intervalMs = this.ctx.config.pollIntervalSec * 1000;
    const iteration$ = () => runEffect("tip iteration", () => this.iterate());
    // `once` runs a single iteration and completes; otherwise tick forever
    // until aborted. A failed iteration is logged and swallowed by runEffect,
    // so one bad poll never tears the loop down.
    const source$ = this.ctx.config.once
      ? iteration$()
      : timer(0, intervalMs).pipe(exhaustMap(iteration$));

    await firstValueFrom(
      source$.pipe(takeUntil(fromAbortSignal(signal)), ignoreElements(), defaultIfEmpty(undefined)),
    );
  }

  /**
   * Identity comes ONLY from local network access: poll the co-located
   * miner's /api/v1/status through the configured front door, which
   * back-fills selfAddress. We never probe on-chain descriptors to find
   * "self" — a reachable global node is not us, and adopting one would
   * mis-identify this deployment. If the local miner is unreachable we warn
   * and leave selfAddress null rather than guessing.
   */
  private async iterate(): Promise<void> {
    const baseUrl = resolveSelfMinerRestUrl(this.ctx.config.validatorRpcUrls);
    if (!baseUrl) {
      // No front door configured — keep the heartbeat fresh so the UI's
      // SyncIndicator knows the indexer process is alive.
      await this.flushHeartbeat();
      return;
    }

    await runTipIteration({
      client: this.clientFactory(baseUrl),
      db: this.ctx.db,
      state: this.ctx.state,
      chainState: this.chainState,
      now: this.ctx.now,
    });
    if (!(await this.ctx.db.getSelfAddress())) {
      console.warn(
        `[indexer/tip] could not identify this node: local miner REST ${baseUrl}/api/v1 ` +
          `is unreachable or returned no ss58. Check that the miner is running and that ` +
          `Caddy fronts /api/v1. Not falling back to a network node.`,
      );
    }
  }

  private async flushHeartbeat(): Promise<void> {
    this.ctx.state.observability.lastStatusFetchAt = nowIso(this.ctx);
    await this.ctx.db.setIndexerObservability(this.ctx.state.observability);
  }
}
