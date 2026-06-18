// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DescriptorWorker: scans finalized `MinerRegistry.NodeDescriptors` snapshots
// written by operators running `quip-miner identify`. Drains the finalized
// block range (checkpoint+1 → head) one block at a time, then idle-polls the
// substrate worker's shared `finalizedBlockHeight` for the next head.
//
// Unlike the substrate worker, this is NOT a stream-merge: it's a stateful
// cursor drain with per-block skip/retry semantics, so the loop stays
// imperative. It owns its own client lifecycle (independent of the canonical
// block writer) so a descriptor-side disconnect doesn't drop blocks and vice
// versa; URL rotation is best-effort round-robin on connect failure / drop.

import type { IndexerConfig } from "../config";
import type { IndexerState } from "../state";
import { type Worker, type WorkerContext } from "../worker";
import {
  type DescriptorIterationDeps,
  type DescriptorReadSource,
  isPrunedStateError,
  runDescriptorIteration,
} from "./iteration";

// Connect/lifecycle slice the worker drives, plus the read slice the iteration
// uses. Satisfied structurally by SubstrateClient and FakeSubstrateClient.
export interface DescriptorSource extends DescriptorReadSource {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
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
  // Wait when caught up to the head or temporarily disconnected. Short enough
  // to feel responsive on a healthy chain, long enough not to hot-spin.
  idlePollMs?: number;
  // Backoff after a per-block RPC error or a failed connect. Substrate-worker
  // handles connection recovery; we just slow our scan so a transient failure
  // doesn't flood the logs.
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

    // Resume from checkpoint if present, else from the configured start.
    // Checkpoint is the highest *successfully processed* block; we start at
    // checkpoint+1. Start block is a CHAIN block number, not an array index —
    // 1 is the first post-genesis block on substrate.
    const checkpoint = await this.db.getDescriptorCheckpoint();
    let nextBlock =
      checkpoint !== null ? BigInt(checkpoint) + 1n : BigInt(this.config.descriptorStartBlock);
    if (nextBlock < 1n) nextBlock = 1n;

    console.log(`[indexer/descriptor] starting scan from block ${nextBlock}`);

    let urlIdx = 0;
    while (!signal.aborted) {
      const url = this.urls[urlIdx]!;
      const client = this.clientFactory(url);
      try {
        await client.connect();
      } catch (e) {
        console.warn(
          `[indexer/descriptor] connect to ${url} failed: ${e instanceof Error ? e.message : e}`,
        );
        urlIdx = (urlIdx + 1) % this.urls.length;
        await sleep(this.errorBackoffMs, signal);
        continue;
      }

      const iterDeps: DescriptorIterationDeps = {
        client,
        db: this.db,
        ...(this.now !== undefined ? { now: this.now } : {}),
      };
      try {
        nextBlock = await this.drain(iterDeps, client, nextBlock, signal);
      } finally {
        try {
          await client.disconnect();
        } catch {
          // best-effort
        }
      }

      if (signal.aborted) return;
      // Connection dropped — rotate URL and reconnect.
      urlIdx = (urlIdx + 1) % this.urls.length;
      await sleep(this.errorBackoffMs, signal);
    }
  }

  // Drain checkpoint+1 → finalized head one block at a time while connected,
  // idling when caught up. Returns the next block to process so a reconnect
  // resumes where it left off.
  private async drain(
    iterDeps: DescriptorIterationDeps,
    client: DescriptorSource,
    startBlock: bigint,
    signal: AbortSignal,
  ): Promise<bigint> {
    let nextBlock = startBlock;
    while (!signal.aborted && client.isConnected()) {
      const finalizedNum = parseBigIntOrNull(this.state.observability.finalizedBlockHeight);
      if (finalizedNum === null || nextBlock > finalizedNum) {
        await sleep(this.idlePollMs, signal);
        continue;
      }

      try {
        const advanced = await runDescriptorIteration(iterDeps, nextBlock.toString());
        if (advanced) {
          nextBlock += 1n;
        } else {
          await sleep(this.errorBackoffMs, signal);
        }
      } catch (e) {
        if (isPrunedStateError(e)) {
          console.warn(`[indexer/descriptor] block ${nextBlock} state pruned; skipping`);
          await this.db.setDescriptorCheckpoint(nextBlock.toString());
          nextBlock += 1n;
        } else {
          console.warn(
            `[indexer/descriptor] block ${nextBlock} scan failed:`,
            e instanceof Error ? e.message : e,
          );
          await sleep(this.errorBackoffMs, signal);
        }
      }
    }
    return nextBlock;
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
