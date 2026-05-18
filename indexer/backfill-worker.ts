// SPDX-License-Identifier: AGPL-3.0-or-later

import { rawBlockToRecord, type DatabaseAdapter } from "../api/db/adapter";
import type { EpochId } from "../src/types/telemetry";

import { AuthError, RateLimitError, type StatusBody } from "./client";
import {
  buildCanonicalPlan,
  formatErr,
  logPrefix,
  saveStateSafely,
  sleepInterruptible,
  type CanonicalEpoch,
  type WorkerDeps,
} from "./shared";
import type { IndexerState } from "./state";

const log = logPrefix("log");
const warn = logPrefix("warn");
const error = logPrefix("error");

export interface BackfillIterationResult {
  blocksIndexed: number;
  blocksSkipped: number;
  planSize: number;
  idle: boolean;
}

/**
 * Partition the plan so canonical-chain entries (those sharing the tip
 * epoch's chain anchor) appear before dead-fork entries. Within each
 * partition the existing ordering (ownedStart ascending) is preserved.
 *
 * Required because `buildCanonicalPlan` sorts by `chainAnchor` string — which
 * can alphabetize a dead fork's anchor before the canonical chain's, pushing
 * live-history indexing behind the abandoned branch. If the tip epoch isn't
 * present in the plan (fresh rollover, transient 404), the plan is returned
 * unchanged — callers still get something safe to iterate.
 */
export function reorderCanonicalFirst(plan: CanonicalEpoch[], tipEpoch: string): CanonicalEpoch[] {
  const tipEntry = plan.find((e) => e.epoch === tipEpoch);
  if (!tipEntry) return plan;
  const tipAnchor = tipEntry.chainAnchor;
  const canonical: CanonicalEpoch[] = [];
  const dead: CanonicalEpoch[] = [];
  for (const entry of plan) {
    if (entry.chainAnchor === tipAnchor) canonical.push(entry);
    else dead.push(entry);
  }
  return [...canonical, ...dead];
}

/**
 * Annotate each plan entry with a `done` flag: true when every block index
 * in `[ownedStart..ownedEnd]` has already been inserted for that epoch.
 *
 * One `getBlocksByEpoch` query per entry — simple and correct for the plan
 * sizes we expect (tens of epochs, rarely hundreds). Optimize later if it
 * becomes a hot path. An "empty" owned range (ownedStart > ownedEnd, not
 * produced by `buildCanonicalPlan` but defended against) is treated as done.
 */
export async function markPlanEntriesDone(
  plan: CanonicalEpoch[],
  db: DatabaseAdapter,
): Promise<Array<CanonicalEpoch & { done: boolean }>> {
  const annotated: Array<CanonicalEpoch & { done: boolean }> = [];
  for (const entry of plan) {
    if (entry.ownedStart > entry.ownedEnd) {
      annotated.push({ ...entry, done: true });
      continue;
    }
    const blocks = await db.getBlocksByEpoch(entry.epoch);
    const present = new Set(blocks.map((b) => b.blockIndex));
    let done = true;
    for (let i = entry.ownedStart; i <= entry.ownedEnd; i++) {
      if (!present.has(i)) {
        done = false;
        break;
      }
    }
    annotated.push({ ...entry, done });
  }
  return annotated;
}

/**
 * Execute one backfill iteration: fetch /status + /epochs, build the plan,
 * filter out the tip epoch, reorder canonical-first, find the first undone
 * entry, and walk its owned range. Observability is written in `finally` so
 * it always runs, even if the block walk throws.
 *
 * The walk checks {@link signal} between blocks so a deep backfill (thousands
 * of blocks in one owned range) can't delay shutdown — abort breaks out of
 * the inner loop, `finally` still runs, state is flushed.
 *
 * Returns `idle: true` when the plan is empty or every entry is done; the
 * caller can then sleep on `backfillIdleRecheckSec` rather than the normal
 * poll interval.
 */
export async function runBackfillIteration(
  deps: WorkerDeps,
  nowMs: number,
  signal: AbortSignal,
): Promise<BackfillIterationResult> {
  const { client, db, state } = deps;
  const result: BackfillIterationResult = {
    blocksIndexed: 0,
    blocksSkipped: 0,
    planSize: 0,
    idle: false,
  };

  let status: StatusBody | null = null;
  try {
    const statusRes = await client.getStatus(null);
    status = statusRes.body;
    if (!status) {
      result.idle = true;
      return result;
    }
    const epochsBody = await client.getEpochs();
    const plan = await buildCanonicalPlan(client, state, status, epochsBody);
    // Filter out the tip epoch (owned by the tip worker), then reorder so
    // canonical-chain entries walk before dead forks. Order is commutative —
    // filter then reorder, or reorder then filter — picking filter-first so
    // the reorder sees a slightly smaller input.
    const filtered = plan.filter((e) => e.epoch !== status!.latestEpoch);
    const ordered = reorderCanonicalFirst(filtered, status.latestEpoch);
    result.planSize = ordered.length;

    // Audit fix #7: any plan entry whose chainAnchor differs from the tip
    // epoch's is a dead-fork chain. Mark its blocks is_canonical=false so
    // default reads hide them. Idempotent — re-running has no effect.
    // (Past canonical history shares the tip's chainAnchor and is left
    // alone; the node's "stale_fork" status tag isn't a reliable signal
    // because it labels everything-but-the-tip the same way.)
    await markDeadForkBlocksNonCanonical(db, plan, status.latestEpoch);

    const annotated = await markPlanEntriesDone(ordered, db);
    const nextEntry = annotated.find((e) => !e.done);
    if (!nextEntry) {
      await markIdle(state);
      result.idle = true;
      return result;
    }
    await walkBackfillEntry(deps, result, nextEntry, nowMs, signal);
    await state.save();
  } finally {
    await writeBackfillObservability(db, state, status, nowMs);
  }
  return result;
}

async function markIdle(state: IndexerState): Promise<void> {
  state.backfillCursor = { epoch: null, blockIndex: 0 };
  await state.save();
}

/**
 * Audit fix #7: epochs that don't share the tip's chainAnchor are dead
 * forks. Their blocks (whether already indexed by an earlier backfill
 * pass or freshly inserted) should be flagged is_canonical=false so the
 * server's default-canonical reads hide them from charts/leaderboards.
 *
 * Idempotent: rerunning produces no additional writes once every dead-
 * fork epoch's rows already carry is_canonical=false.
 */
async function markDeadForkBlocksNonCanonical(
  db: DatabaseAdapter,
  plan: CanonicalEpoch[],
  tipEpoch: string,
): Promise<void> {
  const tipEntry = plan.find((e) => e.epoch === tipEpoch);
  if (!tipEntry) return; // Fresh rollover; defer until we know the tip anchor.
  const tipAnchor = tipEntry.chainAnchor;
  const deadEpochs = plan.filter((e) => e.chainAnchor !== tipAnchor).map((e) => e.epoch);
  if (deadEpochs.length === 0) return;
  await db.markBlocksCanonical(deadEpochs, false);
}

async function writeBackfillObservability(
  db: DatabaseAdapter,
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
      nodesObservedAt: state.observability.nodesObservedAt,
      // Substrate fields carried from the shared cache. The substrate worker
      // is the only mutator; backfill just reflects current state.
      lastSubstrateEventAt: state.observability.lastSubstrateEventAt,
      bestBlockHeight: state.observability.bestBlockHeight,
      finalizedBlockHeight: state.observability.finalizedBlockHeight,
      chainConnected: state.observability.chainConnected,
    });
  } catch (e) {
    warn(`[backfill] setIndexerObservability failed: ${formatErr(e)}`);
  }
}

/**
 * Align `backfillCursor` to {@link entry} if it points elsewhere, then walk
 * the owned range inserting any blocks not already in the DB. 404 responses
 * advance the cursor past the missing block (likely pruned). RateLimitError
 * escapes to the caller so the loop can back off.
 *
 * The loop checks {@link signal} at the top of each iteration and breaks
 * cleanly on abort so shutdown isn't blocked for minutes on a deep range.
 * Breaking (rather than throwing) lets the outer `finally` flush
 * observability with an accurate cursor.
 */
async function walkBackfillEntry(
  deps: WorkerDeps,
  result: BackfillIterationResult,
  entry: CanonicalEpoch,
  nowMs: number,
  signal: AbortSignal,
): Promise<void> {
  const { db, state, config } = deps;

  if (state.backfillCursor.epoch !== entry.epoch) {
    state.backfillCursor = { epoch: entry.epoch, blockIndex: entry.ownedStart - 1 };
  } else if (state.backfillCursor.blockIndex < entry.ownedStart - 1) {
    state.backfillCursor.blockIndex = entry.ownedStart - 1;
  }

  if (config.verbose) {
    log(
      `[backfill] epoch=${entry.epoch} owned=[${entry.ownedStart}..${entry.ownedEnd}] ` +
        `cursor=${state.backfillCursor.blockIndex}`,
    );
  }

  // Skip past blocks already in DB so resuming a partially-indexed epoch
  // doesn't re-fetch covered indices. One query for the whole range.
  const existing = await db.getBlocksByEpoch(entry.epoch);
  const present = new Set(existing.map((b) => b.blockIndex));

  while (state.backfillCursor.blockIndex < entry.ownedEnd) {
    if (signal.aborted) break;
    const nextIndex = state.backfillCursor.blockIndex + 1;
    if (present.has(nextIndex)) {
      state.backfillCursor.blockIndex = nextIndex;
      continue;
    }
    await fetchAndInsertBlock(deps, result, entry.epoch, nextIndex, nowMs);
  }
}

async function fetchAndInsertBlock(
  deps: WorkerDeps,
  result: BackfillIterationResult,
  epoch: EpochId,
  blockIndex: number,
  nowMs: number,
): Promise<void> {
  const { client, db, state } = deps;
  let raw: Record<string, unknown> | null;
  try {
    raw = await client.getBlock(epoch, blockIndex);
  } catch (e) {
    if (e instanceof RateLimitError) {
      // Flush the cursor advances made this iteration before bubbling to the
      // backoff handler — otherwise the `finally` observability write reports
      // a stale backfillCursor.
      await saveStateSafely(state, "rate limit");
      throw e;
    }
    error(`[backfill] block fetch failed at epoch=${epoch} index=${blockIndex}: ${formatErr(e)}`);
    throw e;
  }
  if (raw === null) {
    warn(`[backfill] block ${epoch}/${blockIndex} returned 404, skipping (likely pruned)`);
    state.backfillCursor.blockIndex = blockIndex;
    result.blocksSkipped += 1;
    return;
  }
  const record = rawBlockToRecord(raw as unknown as Parameters<typeof rawBlockToRecord>[0], epoch);
  await db.insertBlock(record);
  state.backfillCursor.blockIndex = blockIndex;
  state.observability.lastBlockInsertAt = new Date(nowMs).toISOString();
  result.blocksIndexed += 1;
}

/**
 * Drive {@link runBackfillIteration} until {@link signal} aborts or
 * `config.once` is set. Local 429 backoff (5s → 60s). When the iteration
 * returns `idle`, sleep `backfillIdleRecheckSec` before rebuilding the plan
 * instead of the normal poll interval.
 */
export async function runBackfillLoop(deps: WorkerDeps, signal: AbortSignal): Promise<void> {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  let backoffMs = 0;

  while (!signal.aborted) {
    let idle = false;
    try {
      const r = await runBackfillIteration(deps, now(), signal);
      backoffMs = 0;
      idle = r.idle;
      if (config.verbose) {
        log(
          `[backfill] iter: indexed=${r.blocksIndexed} skipped=${r.blocksSkipped} ` +
            `plan=${r.planSize} idle=${r.idle}`,
        );
      }
      if (config.once) return;
    } catch (e) {
      if (e instanceof AuthError) {
        error(`[backfill] ${e.message}`);
        throw e;
      }
      if (e instanceof RateLimitError) {
        backoffMs = backoffMs === 0 ? 5000 : Math.min(backoffMs * 2, 60000);
        warn(`[backfill] rate limited, backing off ${backoffMs}ms`);
        await sleepInterruptible(backoffMs, signal);
        if (config.once) throw e;
        continue;
      }
      error(`[backfill] iteration failed: ${formatErr(e)}`);
      if (config.once) throw e;
    }
    const sleepMs = idle ? config.backfillIdleRecheckSec * 1000 : config.pollIntervalSec * 1000;
    await sleepInterruptible(sleepMs, signal);
  }
}
