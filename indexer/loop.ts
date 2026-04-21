// SPDX-License-Identifier: AGPL-3.0-or-later

import { rawBlockToRecord, rawNodesToSnapshot, type DatabaseAdapter } from "../api/db/adapter";

import { AuthError, QuipClient, RateLimitError, type StatusBody } from "./client";
import type { IndexerConfig } from "./config";
import { IndexerState } from "./state";

export interface LoopDeps {
  config: IndexerConfig;
  client: QuipClient;
  db: DatabaseAdapter;
  state: IndexerState;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface IterationResult {
  fetchedStatus: boolean;
  blocksIndexed: number;
  blocksSkipped: number;
  nodesRefreshed: boolean;
  // null when the iteration short-circuited before a status body was seen
  status: StatusBody | null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function logPrefix(verb: "log" | "warn" | "error"): (...args: unknown[]) => void {
  const fn = console[verb].bind(console);
  return (...args: unknown[]) => fn("[indexer]", ...args);
}

const log = logPrefix("log");
const warn = logPrefix("warn");
const error = logPrefix("error");

/**
 * One polling iteration: fetch status, fetch any new blocks in the current
 * epoch, optionally refresh the node snapshot, persist cursor + etags.
 */
export async function runIteration(
  deps: LoopDeps,
  lastNodesFetchMs: { value: number },
): Promise<IterationResult> {
  const { client, db, state, config } = deps;
  const now = deps.now ?? Date.now;
  const result: IterationResult = {
    fetchedStatus: false,
    blocksIndexed: 0,
    blocksSkipped: 0,
    nodesRefreshed: false,
    status: null,
  };

  const statusRes = await client.getStatus(state.etags.status);
  result.fetchedStatus = true;
  if (statusRes.status === 304 || !statusRes.body) {
    if (config.verbose) log("status 304, no changes");
    return result;
  }

  const status = statusRes.body;
  result.status = status;
  if (statusRes.etag) state.etags.status = statusRes.etag;

  // Decide the cursor epoch for this iteration.
  //
  // - Fresh boot (cursor.epoch === null):
  //     - backfill configured: start at BACKFILL_FROM_EPOCH
  //     - otherwise: start at the node's latest epoch
  // - Cursor ahead of the node (epoch rolled back): reset to latest
  // - Cursor behind the node:
  //     - backfill configured: keep the current epoch; we will advance
  //       through epochs one at a time
  //     - otherwise: jump to the latest epoch (natural epoch transition)
  if (state.cursor.epoch === null) {
    if (config.backfillFromEpoch !== undefined && config.backfillFromEpoch <= status.latestEpoch) {
      state.cursor = { epoch: config.backfillFromEpoch, blockIndex: 0 };
      log(`backfill enabled: starting from epoch ${config.backfillFromEpoch}`);
    } else {
      state.cursor = { epoch: status.latestEpoch, blockIndex: 0 };
      log(`fresh boot: starting at epoch ${status.latestEpoch}`);
    }
  } else if (state.cursor.epoch > status.latestEpoch) {
    warn(
      `cursor epoch ${state.cursor.epoch} > latestEpoch ${status.latestEpoch}; node rolled back, resetting`,
    );
    state.cursor = { epoch: status.latestEpoch, blockIndex: 0 };
  } else if (state.cursor.epoch < status.latestEpoch && config.backfillFromEpoch === undefined) {
    log(`epoch transition: ${state.cursor.epoch} -> ${status.latestEpoch}, resetting cursor`);
    state.cursor = { epoch: status.latestEpoch, blockIndex: 0 };
  }

  const cursorEpoch = state.cursor.epoch;
  if (cursorEpoch === null) return result;

  // Work out the last block index for the current iteration's epoch.
  // In the common case we index the tip epoch and use status.latestBlockIndex.
  // During backfill (cursorEpoch < latestEpoch) we fetch /epochs to find the
  // final block of the epoch we are currently draining.
  let epochLastBlock: number;
  if (cursorEpoch === status.latestEpoch) {
    epochLastBlock = status.latestBlockIndex;
  } else {
    const epochs = await client.getEpochs();
    const match = epochs.epochs.find((e) => e.epoch === cursorEpoch);
    if (!match) {
      warn(`backfill: epoch ${cursorEpoch} not present in /epochs; skipping to next epoch`);
      state.cursor = { epoch: cursorEpoch + 1, blockIndex: 0 };
      await state.save();
      return result;
    }
    epochLastBlock = match.lastBlock;
    if (config.verbose) {
      log(`backfill: epoch ${cursorEpoch} lastBlock=${epochLastBlock}`);
    }
  }

  // Catch up on blocks in the current epoch. insertBlock failures break the
  // loop and persist the cursor up to the last successful insert so the next
  // iteration resumes from the right place.
  while (state.cursor.blockIndex < epochLastBlock) {
    const nextIndex = state.cursor.blockIndex + 1;
    let raw: Record<string, unknown> | null;
    try {
      raw = await client.getBlock(cursorEpoch, nextIndex);
    } catch (e) {
      if (e instanceof RateLimitError) {
        // Persist progress through the previous block so backoff in runLoop
        // does not cause us to re-fetch what we already indexed.
        try {
          await state.save();
        } catch (saveErr) {
          error(`state.save failed after rate limit: ${formatErr(saveErr)}`);
        }
        throw e;
      }
      error(`block fetch failed at epoch=${cursorEpoch} index=${nextIndex}: ${formatErr(e)}`);
      break;
    }
    if (raw === null) {
      warn(`block ${cursorEpoch}/${nextIndex} returned 404, skipping (likely pruned)`);
      state.cursor.blockIndex = nextIndex;
      result.blocksSkipped += 1;
      continue;
    }
    const record = rawBlockToRecord(
      raw as unknown as Parameters<typeof rawBlockToRecord>[0],
      cursorEpoch,
    );
    try {
      await db.insertBlock(record);
    } catch (e) {
      error(`insertBlock failed at epoch=${cursorEpoch} index=${nextIndex}: ${formatErr(e)}`);
      // Persist whatever progress we made before bailing so the next
      // iteration does not re-fetch already-committed blocks.
      try {
        await state.save();
      } catch (saveErr) {
        error(`state.save failed after insertBlock error: ${formatErr(saveErr)}`);
      }
      throw e;
    }
    state.cursor.blockIndex = nextIndex;
    result.blocksIndexed += 1;
  }

  // If we just finished an older epoch, advance to the next one so the next
  // iteration picks up where we left off. We only advance when we actually
  // reached the end of the epoch (not on an error-break above).
  if (cursorEpoch < status.latestEpoch && state.cursor.blockIndex >= epochLastBlock) {
    log(`backfill: epoch ${cursorEpoch} complete (${epochLastBlock} blocks), advancing`);
    state.cursor = { epoch: cursorEpoch + 1, blockIndex: 0 };
  }

  // Refresh node snapshot on its own cadence.
  const sinceNodesMs = now() - lastNodesFetchMs.value;
  if (sinceNodesMs >= config.nodesRefreshSec * 1000) {
    try {
      const nodesRes = await client.getNodes(state.etags.nodes);
      if (nodesRes.status !== 304 && nodesRes.body) {
        const snapshot = rawNodesToSnapshot(
          nodesRes.body as unknown as Parameters<typeof rawNodesToSnapshot>[0],
        );
        await db.upsertNodes(snapshot);
        if (nodesRes.etag) state.etags.nodes = nodesRes.etag;
        result.nodesRefreshed = true;
        if (config.verbose) {
          log(`refreshed nodes: ${snapshot.nodeCount} total`);
        }
      }
    } catch (e) {
      if (e instanceof RateLimitError) {
        try {
          await state.save();
        } catch (saveErr) {
          error(`state.save failed after rate limit: ${formatErr(saveErr)}`);
        }
        throw e;
      }
      warn(`nodes fetch failed: ${formatErr(e)}`);
    }
    lastNodesFetchMs.value = now();
  }

  await state.save();
  return result;
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.stack ?? e.message;
  return String(e);
}

/**
 * Run the polling loop until a stop signal or one iteration in --once mode.
 * Implements 429 exponential backoff (5s → 60s) and warn-log for 5xx/network.
 */
export async function runLoop(deps: LoopDeps, shouldStop: () => boolean): Promise<void> {
  const { config } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const lastNodesFetch = { value: 0 };
  let backoffMs = 0;

  while (!shouldStop()) {
    try {
      const r = await runIteration(deps, lastNodesFetch);
      backoffMs = 0;
      if (config.verbose) {
        log(
          `iter: indexed=${r.blocksIndexed} skipped=${r.blocksSkipped} nodes=${r.nodesRefreshed}`,
        );
      }
      if (config.once) return;
    } catch (e) {
      if (e instanceof AuthError) {
        // Surface to main.ts so cleanup (db.disconnect) runs before exit.
        error(e.message);
        throw e;
      }
      if (e instanceof RateLimitError) {
        backoffMs = backoffMs === 0 ? 5000 : Math.min(backoffMs * 2, 60000);
        warn(`rate limited, backing off ${backoffMs}ms`);
        await sleep(backoffMs);
        if (config.once) throw e;
        continue;
      }
      error(`iteration failed: ${formatErr(e)}`);
      if (config.once) throw e;
    }
    await sleep(config.pollIntervalSec * 1000);
  }
}
