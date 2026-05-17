// SPDX-License-Identifier: AGPL-3.0-or-later

import { rawBlockToRecord, rawNodesToSnapshot } from "../api/db/adapter";
import type { EpochId } from "../src/types/telemetry";

import { AuthError, RateLimitError, type EpochsBody, type StatusBody } from "./client";
import {
  ensureChainAnchor,
  formatErr,
  logPrefix,
  maybeWarnStalled,
  refreshSelfAddress,
  saveStateSafely,
  sleepInterruptible,
  updateStallTracker,
  type WorkerDeps,
} from "./shared";
import type { IndexerState } from "./state";
import type { QuipClient } from "./client";

const log = logPrefix("log");
const warn = logPrefix("warn");
const error = logPrefix("error");

export interface TipIterationResult {
  fetchedStatus: boolean;
  blocksIndexed: number;
  blocksSkipped: number;
  nodesRefreshed: boolean;
  status: StatusBody | null;
}

/**
 * Compute ownedStart for the node's tip epoch, chain-aware.
 *
 * ownedStart = (largest `lastBlock` among other epochs on the SAME chain whose
 * `lastBlock < status.latestBlockIndex`) + 1, or 1 when no prior epoch covers
 * the tip's chain. Returns null if the tip epoch's block 1 isn't resolvable
 * yet (fresh rollover, transient 404).
 *
 * Lighter than `buildCanonicalPlan` — we only resolve chain anchors for
 * epochs whose lastBlock could plausibly precede the tip. For every poll of a
 * healthy node this is ~O(1) anchor fetches (cached on IndexerState).
 */
export async function computeTipOwnedStart(
  client: QuipClient,
  state: IndexerState,
  status: StatusBody,
  epochsBody: EpochsBody,
): Promise<number | null> {
  const tipAnchor = await ensureChainAnchor(client, state, status.latestEpoch);
  if (!tipAnchor) return null;

  let priorLast = 0;
  for (const e of epochsBody.epochs) {
    if (e.epoch === status.latestEpoch) continue;
    if (e.lastBlock <= 0 || e.lastBlock >= status.latestBlockIndex) continue;
    const anchor = await ensureChainAnchor(client, state, e.epoch);
    if (anchor !== tipAnchor) continue;
    if (e.lastBlock > priorLast) priorLast = e.lastBlock;
  }
  return priorLast + 1;
}

/**
 * Execute one polling iteration of the tip worker: fetch /status, snapshot
 * the tip epoch's owned range, walk any new blocks, refresh nodes on cadence,
 * and write the observability heartbeat.
 *
 * `lastNodesFetchMs` is threaded in as a mutable ref so runTipLoop can
 * preserve the timestamp across iterations without storing it on state.
 */
export async function runTipIteration(
  deps: WorkerDeps,
  nowMs: number,
  lastNodesFetchMs: { value: number } = { value: 0 },
): Promise<TipIterationResult> {
  const { client, db, state, config } = deps;
  const result: TipIterationResult = {
    fetchedStatus: false,
    blocksIndexed: 0,
    blocksSkipped: 0,
    nodesRefreshed: false,
    status: null,
  };

  const statusRes = await client.getStatus(null);
  result.fetchedStatus = true;
  const status = statusRes.body;
  result.status = status;

  if (status) {
    updateStallTracker(state, status, nowMs);
    maybeWarnStalled(state, config, nowMs);
  }

  try {
    if (status) {
      await runTipIterationBody(deps, lastNodesFetchMs, result, status, nowMs);
    }
  } finally {
    await writeTipObservability(db, state, status, nowMs);
  }

  return result;
}

async function writeTipObservability(
  db: WorkerDeps["db"],
  state: IndexerState,
  status: StatusBody | null,
  nowMs: number,
): Promise<void> {
  try {
    await db.setIndexerObservability({
      nodeLatestEpoch: status?.latestEpoch ?? state.tipCursor.epoch ?? "",
      nodeLatestBlockIndex: status?.latestBlockIndex ?? 0,
      tipEpoch: state.tipCursor.epoch,
      tipBlockIndex: state.tipCursor.blockIndex,
      backfillEpoch: state.backfillCursor.epoch,
      backfillBlockIndex: state.backfillCursor.blockIndex,
      lastStatusFetchAt: new Date(nowMs).toISOString(),
      lastBlockInsertAt: state.observability.lastBlockInsertAt,
      // Substrate worker mutates these via state.observability; tip-worker
      // is the only writer of setIndexerObservability so it carries them
      // through to the DB.
      lastSubstrateEventAt: state.observability.lastSubstrateEventAt,
      bestBlockHeight: state.observability.bestBlockHeight,
      finalizedBlockHeight: state.observability.finalizedBlockHeight,
      chainConnected: state.observability.chainConnected,
    });
  } catch (e) {
    warn(`setIndexerObservability failed: ${formatErr(e)}`);
  }
}

async function runTipIterationBody(
  deps: WorkerDeps,
  lastNodesFetchMs: { value: number },
  result: TipIterationResult,
  status: StatusBody,
  nowMs: number,
): Promise<void> {
  const { client, db, state } = deps;

  const epochsBody = await client.getEpochs();
  try {
    await db.replaceEpochStatus(
      epochsBody.epochs.map((e) => ({ epoch: e.epoch, status: e.status })),
    );
  } catch (e) {
    warn(`replaceEpochStatus failed: ${formatErr(e)}`);
  }

  const ownedStart = await computeTipOwnedStart(client, state, status, epochsBody);
  if (ownedStart !== null) {
    reseedTipCursorIfNeeded(state, status, ownedStart);
    await walkTipBlocks(deps, result, status, nowMs);
  }

  await maybeRefreshNodes(deps, lastNodesFetchMs, result, nowMs);
  await state.save();
}

function reseedTipCursorIfNeeded(
  state: IndexerState,
  status: StatusBody,
  ownedStart: number,
): void {
  if (state.tipCursor.epoch !== status.latestEpoch) {
    if (state.tipCursor.epoch !== null) {
      log(
        `tip epoch rolled over: ${state.tipCursor.epoch} -> ${status.latestEpoch}; ` +
          `reseeding cursor at ownedStart=${ownedStart}`,
      );
    }
    state.tipCursor = { epoch: status.latestEpoch, blockIndex: ownedStart - 1 };
    return;
  }
  // Same tip epoch; clamp cursor up to ownedStart-1 if something decremented
  // it (e.g. a prior epoch's lastBlock reversed). Never decrease the cursor
  // in the normal case — we'd re-fetch blocks we've already indexed.
  if (state.tipCursor.blockIndex < ownedStart - 1) {
    state.tipCursor.blockIndex = ownedStart - 1;
  }
}

/**
 * Walk the tip epoch from `state.tipCursor.blockIndex + 1` up to
 * `status.latestBlockIndex`. Unlike the backfill walker, this loop is
 * bounded by `latestBlockIndex - tipBlockIndex` — a small number per poll
 * on a healthy node — so it doesn't need an abort check inside the loop.
 * Shutdown is observed between iterations in `runTipLoop`.
 */
async function walkTipBlocks(
  deps: WorkerDeps,
  result: TipIterationResult,
  status: StatusBody,
  nowMs: number,
): Promise<void> {
  const { client, db, state, config } = deps;

  if (config.verbose) {
    log(
      `tip: epoch=${status.latestEpoch} cursor=${state.tipCursor.blockIndex} ` +
        `target=${status.latestBlockIndex}`,
    );
  }

  while (state.tipCursor.blockIndex < status.latestBlockIndex) {
    const nextIndex = state.tipCursor.blockIndex + 1;
    let raw: Record<string, unknown> | null;
    try {
      raw = await client.getBlock(status.latestEpoch, nextIndex);
    } catch (e) {
      if (e instanceof RateLimitError) {
        await saveStateSafely(state, "rate limit");
        throw e;
      }
      error(
        `block fetch failed at epoch=${status.latestEpoch} index=${nextIndex}: ${formatErr(e)}`,
      );
      break;
    }
    if (raw === null) {
      warn(`block ${status.latestEpoch}/${nextIndex} returned 404, skipping (likely pruned)`);
      state.tipCursor.blockIndex = nextIndex;
      result.blocksSkipped += 1;
      continue;
    }
    const record = rawBlockToRecord(
      raw as unknown as Parameters<typeof rawBlockToRecord>[0],
      status.latestEpoch,
    );
    try {
      await db.insertBlock(record);
    } catch (e) {
      error(
        `insertBlock failed at epoch=${status.latestEpoch} index=${nextIndex}: ${formatErr(e)}`,
      );
      await saveStateSafely(state, "insertBlock error");
      throw e;
    }
    state.tipCursor.blockIndex = nextIndex;
    state.observability.lastBlockInsertAt = new Date(nowMs).toISOString();
    result.blocksIndexed += 1;
    // Drain any BlockWinner event that arrived before this PoW block did
    // (race between substrate-worker subscription and REST poll). Keyed
    // by (minerId, energy) — the chain emits the same energy_milli the
    // miner reports here, so an exact-equality lookup is safe.
    await drainPendingWinnerEvent(deps, record);
  }
}

async function drainPendingWinnerEvent(
  deps: WorkerDeps,
  record: { epoch: EpochId; blockIndex: number; minerId: string; energy: number },
): Promise<void> {
  const { db, state } = deps;
  const key = `${record.minerId}:${record.energy}` as const;
  const pending = state.pendingWinnerEvents.get(key);
  if (!pending) return;
  state.pendingWinnerEvents.delete(key);
  try {
    await db.updateBlockSubstrateFields(record.epoch, record.blockIndex, {
      substrateBlockNumber: pending.submittedAt,
      substrateBlockHash: pending.substrateBlockHash,
      substrateParentHash: pending.substrateParentHash,
      extrinsicsRoot: pending.extrinsicsRoot,
      stateRoot: pending.stateRoot,
    });
  } catch (e) {
    warn(`drainPendingWinnerEvent failed for ${key}: ${formatErr(e)}`);
  }
}

async function maybeRefreshNodes(
  deps: WorkerDeps,
  lastNodesFetchMs: { value: number },
  result: TipIterationResult,
  nowMs: number,
): Promise<void> {
  const { client, db, state, config } = deps;
  const sinceNodesMs = nowMs - lastNodesFetchMs.value;
  if (sinceNodesMs < config.nodesRefreshSec * 1000) return;
  try {
    const nodesRes = await client.getNodes(state.etags.nodes);
    if (nodesRes.status !== 304 && nodesRes.body) {
      const snapshot = rawNodesToSnapshot(
        nodesRes.body as unknown as Parameters<typeof rawNodesToSnapshot>[0],
      );
      await db.upsertNodes(snapshot);
      if (nodesRes.etag) state.etags.nodes = nodesRes.etag;
      result.nodesRefreshed = true;
      await refreshSelfAddress(db, client, snapshot);
      if (config.verbose) {
        log(`refreshed nodes: ${snapshot.nodeCount} total`);
      }
    }
  } catch (e) {
    if (e instanceof RateLimitError) {
      await saveStateSafely(state, "rate limit");
      throw e;
    }
    warn(`nodes fetch failed: ${formatErr(e)}`);
  }
  lastNodesFetchMs.value = nowMs;
}

/**
 * Drive `runTipIteration` until the abort signal fires or `config.once` is
 * set. Handles 429 backoff locally (5s → 60s cap) and sleeps between
 * iterations on the configured poll interval. AuthError rethrows; other
 * errors log and continue so a single bad response doesn't kill the worker.
 */
export async function runTipLoop(deps: WorkerDeps, signal: AbortSignal): Promise<void> {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const lastNodesFetch = { value: 0 };
  let backoffMs = 0;

  while (!signal.aborted) {
    try {
      await runTipIteration(deps, now(), lastNodesFetch);
      backoffMs = 0;
      if (config.once) return;
    } catch (e) {
      if (e instanceof AuthError) {
        error(e.message);
        throw e;
      }
      if (e instanceof RateLimitError) {
        backoffMs = backoffMs === 0 ? 5000 : Math.min(backoffMs * 2, 60000);
        warn(`tip worker rate limited, backing off ${backoffMs}ms`);
        await sleepInterruptible(backoffMs, signal);
        if (config.once) throw e;
        continue;
      }
      error(`tip iteration failed: ${formatErr(e)}`);
      if (config.once) throw e;
    }
    await sleepInterruptible(config.pollIntervalSec * 1000, signal);
  }
}
