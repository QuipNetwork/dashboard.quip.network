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

  // New chain head or fresh boot: jump to latest epoch, reset block cursor.
  // Backfill: if BACKFILL_FROM_EPOCH is set and we're fresh, start there
  // (indexing forward through all epochs ≥ that one).
  if (state.cursor.epoch === null) {
    if (config.backfillFromEpoch !== undefined && config.backfillFromEpoch <= status.latestEpoch) {
      state.cursor = { epoch: config.backfillFromEpoch, blockIndex: 0 };
      log(`backfill enabled: starting from epoch ${config.backfillFromEpoch}`);
    } else {
      state.cursor = { epoch: status.latestEpoch, blockIndex: 0 };
      log(`fresh boot: starting at epoch ${status.latestEpoch}`);
    }
  } else if (state.cursor.epoch !== status.latestEpoch) {
    // Epoch transition. Fetch /epochs for visibility, but we only index the
    // latest epoch going forward (unless backfilling through prior epochs).
    try {
      const epochs = await client.getEpochs();
      if (config.verbose) {
        log(`epoch list: ${epochs.epochs.map((e) => e.epoch).join(", ")}`);
      }
    } catch (e) {
      warn("failed to fetch /epochs during transition:", formatErr(e));
    }
    log(`epoch transition: ${state.cursor.epoch} -> ${status.latestEpoch}, resetting cursor`);
    state.cursor = { epoch: status.latestEpoch, blockIndex: 0 };
  }

  // Catch up on blocks in the current epoch.
  // The status.latestBlockIndex is the highest indexed block; we fetch
  // cursor.blockIndex + 1 up to and including latestBlockIndex.
  const cursorEpoch = state.cursor.epoch;
  if (cursorEpoch === null) return result;

  while (state.cursor.blockIndex < status.latestBlockIndex) {
    const nextIndex = state.cursor.blockIndex + 1;
    let raw: Record<string, unknown> | null;
    try {
      raw = await client.getBlock(cursorEpoch, nextIndex);
    } catch (e) {
      warn(`block fetch failed at epoch=${cursorEpoch} index=${nextIndex}: ${formatErr(e)}`);
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
    await db.insertBlock(record);
    state.cursor.blockIndex = nextIndex;
    result.blocksIndexed += 1;
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
      warn(`nodes fetch failed: ${formatErr(e)}`);
    }
    lastNodesFetchMs.value = now();
  }

  await state.save();
  return result;
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
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
        error(e.message);
        process.exit(1);
      }
      if (e instanceof RateLimitError) {
        backoffMs = backoffMs === 0 ? 5000 : Math.min(backoffMs * 2, 60000);
        warn(`rate limited, backing off ${backoffMs}ms`);
        await sleep(backoffMs);
        if (config.once) return;
        continue;
      }
      warn(`iteration failed: ${formatErr(e)}`);
      if (config.once) return;
    }
    await sleep(config.pollIntervalSec * 1000);
  }
}
