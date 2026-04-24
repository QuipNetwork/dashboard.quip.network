// SPDX-License-Identifier: AGPL-3.0-or-later

export * from "./shared";

import { rawBlockToRecord, rawNodesToSnapshot } from "../api/db/adapter";
import type { EpochId } from "../src/types/telemetry";

import { AuthError, RateLimitError, type StatusBody } from "./client";
import {
  buildCanonicalPlan,
  defaultSleep,
  formatErr,
  logPrefix,
  maybeWarnStalled,
  refreshSelfAddress,
  updateStallTracker,
  type CanonicalEpoch,
  type WorkerDeps,
} from "./shared";
import type { IndexerConfig } from "./config";

export interface IterationResult {
  fetchedStatus: boolean;
  blocksIndexed: number;
  blocksSkipped: number;
  nodesRefreshed: boolean;
  // null when the iteration short-circuited before a status body was seen
  status: StatusBody | null;
}

const log = logPrefix("log");
const warn = logPrefix("warn");
const error = logPrefix("error");

/**
 * One polling iteration: fetch status, fetch any new blocks in the current
 * epoch, optionally refresh the node snapshot, persist cursor + etags.
 */
export async function runIteration(
  deps: WorkerDeps,
  lastNodesFetchMs: { value: number },
): Promise<IterationResult> {
  const { client, db, state, config } = deps;
  const now = deps.now ?? Date.now;
  // One wall-clock read per iteration. All downstream consumers (stall
  // tracker, warn throttle, observability ISO timestamps) operate on a
  // single coherent frame; otherwise they can drift by microseconds and
  // make the bootstrap-grace invariant harder to reason about in tests.
  const nowMs = now();
  const result: IterationResult = {
    fetchedStatus: false,
    blocksIndexed: 0,
    blocksSkipped: 0,
    nodesRefreshed: false,
    status: null,
  };

  // /status is fetched without ETag so a 304 never prevents catch-up when
  // we are behind the tip of an unchanged epoch. The body is small.
  const statusRes = await client.getStatus(null);
  result.fetchedStatus = true;
  if (!statusRes.body) return result;

  const status = statusRes.body;
  result.status = status;

  // Track whether the node's reported tip is advancing. Operators need to
  // know when the polled node has stopped producing blocks (forked, sync
  // lag, telemetry bug) — otherwise the dashboard just silently falls
  // behind with no hint as to why.
  updateStallTracker(state, status, nowMs);
  maybeWarnStalled(state, config, nowMs);

  // Persist the observability heartbeat on every successful /status fetch,
  // including error/early-return paths below. Without this the UI's
  // lastStatusFetchAt-based "indexer alive" check goes stale during backfill
  // bursts and rate-limit retries — exactly the cases operators care about.
  // The write is best-effort: logging on failure avoids poison-pilling the
  // iteration if the meta-table write transiently fails.
  let observabilityWritten = false;
  const writeObservability = async (): Promise<void> => {
    if (observabilityWritten) return;
    observabilityWritten = true;
    try {
      await db.setIndexerObservability({
        nodeLatestEpoch: status.latestEpoch,
        nodeLatestBlockIndex: status.latestBlockIndex,
        tipEpoch: state.tipCursor.epoch,
        tipBlockIndex: state.tipCursor.blockIndex,
        backfillEpoch: null,
        backfillBlockIndex: 0,
        lastStatusFetchAt: new Date(nowMs).toISOString(),
        lastBlockInsertAt: state.observability.lastBlockInsertAt,
      });
    } catch (e) {
      warn(`setIndexerObservability failed: ${formatErr(e)}`);
    }
  };

  try {
    return await runIterationBody(deps, lastNodesFetchMs, result, status, nowMs);
  } finally {
    await writeObservability();
  }
}

async function runIterationBody(
  deps: WorkerDeps,
  lastNodesFetchMs: { value: number },
  result: IterationResult,
  status: StatusBody,
  nowMs: number,
): Promise<IterationResult> {
  const { client, db, state, config } = deps;

  // Canonicalise before indexing anything. The node can maintain multiple
  // chains simultaneously (forks, solo-mine restarts, reorgs) and exposes
  // every historical chain through /epochs. Walking all of them would tag
  // the same physical block under multiple epoch IDs. The plan collapses
  // that down to just the canonical chain (the one containing
  // status.latestEpoch) with per-epoch owned ranges. Empty plan means the
  // node has no block 1 yet (early bootstrap or transient 404) — we still
  // do the nodes-refresh / observability work below, just no indexing.
  const epochsBody = await client.getEpochs();
  // Mirror the node's live/stale_fork tagging into the DB so the UI's
  // epoch selector can badge each option. Writing before the walk keeps
  // the common case (blocks indexed → getIndex reads status) in sync even
  // if this poll's walk is interrupted.
  try {
    await db.replaceEpochStatus(
      epochsBody.epochs.map((e) => ({ epoch: e.epoch, status: e.status })),
    );
  } catch (e) {
    warn(`replaceEpochStatus failed: ${formatErr(e)}`);
  }
  const plan = await buildCanonicalPlan(client, state, status, epochsBody);
  if (plan.length > 0) {
    await walkCanonicalPlan(deps, result, plan, nowMs);
  }

  // Refresh node snapshot on its own cadence.
  const sinceNodesMs = nowMs - lastNodesFetchMs.value;
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
        // Resolve which node in the snapshot is "us" by asking the node
        // directly via /api/v1/status. Persists only on change to keep the
        // meta table quiet.
        await refreshSelfAddress(db, client, snapshot);
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
    lastNodesFetchMs.value = nowMs;
  }

  await state.save();
  return result;
}

/**
 * Walk the canonical plan: seed the cursor if fresh, skip forward off any
 * dead-chain position, then index whatever owned blocks remain in the
 * current canonical epoch. Advances to the next canonical epoch once the
 * current one's owned range is drained.
 */
async function walkCanonicalPlan(
  deps: WorkerDeps,
  result: IterationResult,
  plan: CanonicalEpoch[],
  nowMs: number,
): Promise<void> {
  const { client, db, state, config } = deps;

  if (state.tipCursor.epoch === null) {
    const seed = chooseCanonicalSeed(plan, config);
    state.tipCursor = { epoch: seed, blockIndex: 0 };
    log(`fresh boot: seeding cursor at canonical epoch ${seed}`);
  }

  let cursorIdx = plan.findIndex((e) => e.epoch === state.tipCursor.epoch);
  if (cursorIdx < 0) {
    // Cursor's epoch vanished from the plan — most often the node pruned a
    // dead fork we were mid-walk on. Epoch IDs are hashes now so there is
    // no numeric ordering to pick a "successor" from; fall back to plan[0]
    // and let idempotent inserts handle anything already indexed.
    const seed = plan[0]!;
    warn(
      `cursor epoch ${state.tipCursor.epoch} is not in the index plan; ` +
        `resetting to earliest plan entry ${seed.epoch}`,
    );
    state.tipCursor = { epoch: seed.epoch, blockIndex: 0 };
    cursorIdx = 0;
  }

  const current = plan[cursorIdx]!;

  // Respect the owned range. Cursor starts at (ownedStart - 1) so the first
  // block fetched is ownedStart. Prevents re-fetching blocks that belong
  // to an earlier canonical epoch.
  if (state.tipCursor.blockIndex < current.ownedStart - 1) {
    state.tipCursor.blockIndex = current.ownedStart - 1;
  }

  if (config.verbose) {
    log(
      `canonical: epoch=${current.epoch} owned=[${current.ownedStart}..${current.ownedEnd}] cursor=${state.tipCursor.blockIndex}`,
    );
  }

  while (state.tipCursor.blockIndex < current.ownedEnd) {
    const nextIndex = state.tipCursor.blockIndex + 1;
    let raw: Record<string, unknown> | null;
    try {
      raw = await client.getBlock(current.epoch, nextIndex);
    } catch (e) {
      if (e instanceof RateLimitError) {
        try {
          await state.save();
        } catch (saveErr) {
          error(`state.save failed after rate limit: ${formatErr(saveErr)}`);
        }
        throw e;
      }
      error(`block fetch failed at epoch=${current.epoch} index=${nextIndex}: ${formatErr(e)}`);
      break;
    }
    if (raw === null) {
      warn(`block ${current.epoch}/${nextIndex} returned 404, skipping (likely pruned)`);
      state.tipCursor.blockIndex = nextIndex;
      result.blocksSkipped += 1;
      continue;
    }
    const record = rawBlockToRecord(
      raw as unknown as Parameters<typeof rawBlockToRecord>[0],
      current.epoch,
    );
    try {
      await db.insertBlock(record);
    } catch (e) {
      error(`insertBlock failed at epoch=${current.epoch} index=${nextIndex}: ${formatErr(e)}`);
      try {
        await state.save();
      } catch (saveErr) {
        error(`state.save failed after insertBlock error: ${formatErr(saveErr)}`);
      }
      throw e;
    }
    state.tipCursor.blockIndex = nextIndex;
    state.observability.lastBlockInsertAt = new Date(nowMs).toISOString();
    result.blocksIndexed += 1;
  }

  // Drained this epoch — advance to the next in the plan. Carry
  // blockIndex forward within a chain so inherited blocks aren't re-fetched,
  // but reset to 0 when crossing into a different chain so the new chain's
  // owned range starts from its block 1.
  if (state.tipCursor.blockIndex >= current.ownedEnd && cursorIdx < plan.length - 1) {
    const next = plan[cursorIdx + 1]!;
    const carryBlock = next.chainAnchor === current.chainAnchor ? current.ownedEnd : 0;
    log(
      `epoch ${current.epoch} (chain ${current.chainAnchor.slice(0, 8)}…) drained at ${current.ownedEnd}; advancing to ${next.epoch}`,
    );
    state.tipCursor = { epoch: next.epoch, blockIndex: carryBlock };
  }
}

/**
 * Pick the initial cursor epoch for a fresh boot. If
 * `config.backfillFromEpoch` is set and that epoch is in the plan, honor
 * it; otherwise start from the earliest epoch in the plan so the full
 * history gets indexed (including dead chains).
 */
function chooseCanonicalSeed(plan: CanonicalEpoch[], config: IndexerConfig): EpochId {
  const first = plan[0]!;
  const configured = config.backfillFromEpoch;
  if (configured === undefined) return first.epoch;
  const match = plan.find((e) => e.epoch === configured);
  if (match) return configured;
  warn(`BACKFILL_FROM_EPOCH=${configured} not in index plan; seeding from ${first.epoch} instead`);
  return first.epoch;
}

/**
 * Run the polling loop until a stop signal or one iteration in --once mode.
 * Implements 429 exponential backoff (5s → 60s) and warn-log for 5xx/network.
 */
export async function runLoop(deps: WorkerDeps, shouldStop: () => boolean): Promise<void> {
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
