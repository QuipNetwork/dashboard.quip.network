// SPDX-License-Identifier: AGPL-3.0-or-later

import { rawBlockToRecord, rawNodesToSnapshot, type DatabaseAdapter } from "../api/db/adapter";
import type { EpochId, NodesSnapshot } from "../src/types/telemetry";

import { AuthError, QuipClient, RateLimitError, type EpochsBody, type StatusBody } from "./client";
import type { IndexerConfig } from "./config";
import { IndexerState } from "./state";

/**
 * An epoch annotated with the block range it OWNS on its chain — the slice
 * of that chain's history first introduced during this epoch.
 *
 * Quip epochs carry the full chain history (from block 1) up to the epoch's
 * tip, so the same block_index can appear under multiple epoch URLs within
 * the same chain. Owned ranges disambiguate: each block is attributed to
 * exactly one epoch — the earliest epoch on its chain that contained it.
 *
 *   ownedStart = (previous epoch on THIS chain's lastBlock) + 1  (or 1 if
 *                this is the first epoch on the chain)
 *   ownedEnd   = this epoch's lastBlock (or status.latestBlockIndex for the
 *                tip epoch, which is fresher than /epochs)
 *
 * Dead chains (ones whose block-1 hash doesn't match `status.latestEpoch`'s)
 * still get indexed — operators want the forensic history of abandoned
 * branches. Grouping is by block-1 hash so each dead chain has its own
 * owned-range accounting.
 */
export interface CanonicalEpoch {
  epoch: EpochId;
  chainAnchor: string;
  ownedStart: number;
  ownedEnd: number;
}

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
        cursorEpoch: state.cursor.epoch,
        cursorBlockIndex: state.cursor.blockIndex,
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
  deps: LoopDeps,
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
  deps: LoopDeps,
  result: IterationResult,
  plan: CanonicalEpoch[],
  nowMs: number,
): Promise<void> {
  const { client, db, state, config } = deps;

  if (state.cursor.epoch === null) {
    const seed = chooseCanonicalSeed(plan, config);
    state.cursor = { epoch: seed, blockIndex: 0 };
    log(`fresh boot: seeding cursor at canonical epoch ${seed}`);
  }

  let cursorIdx = plan.findIndex((e) => e.epoch === state.cursor.epoch);
  if (cursorIdx < 0) {
    // Cursor's epoch vanished from the plan — most often the node pruned a
    // dead fork we were mid-walk on. Epoch IDs are hashes now so there is
    // no numeric ordering to pick a "successor" from; fall back to plan[0]
    // and let idempotent inserts handle anything already indexed.
    const seed = plan[0]!;
    warn(
      `cursor epoch ${state.cursor.epoch} is not in the index plan; ` +
        `resetting to earliest plan entry ${seed.epoch}`,
    );
    state.cursor = { epoch: seed.epoch, blockIndex: 0 };
    cursorIdx = 0;
  }

  const current = plan[cursorIdx]!;

  // Respect the owned range. Cursor starts at (ownedStart - 1) so the first
  // block fetched is ownedStart. Prevents re-fetching blocks that belong
  // to an earlier canonical epoch.
  if (state.cursor.blockIndex < current.ownedStart - 1) {
    state.cursor.blockIndex = current.ownedStart - 1;
  }

  if (config.verbose) {
    log(
      `canonical: epoch=${current.epoch} owned=[${current.ownedStart}..${current.ownedEnd}] cursor=${state.cursor.blockIndex}`,
    );
  }

  while (state.cursor.blockIndex < current.ownedEnd) {
    const nextIndex = state.cursor.blockIndex + 1;
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
      state.cursor.blockIndex = nextIndex;
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
    state.cursor.blockIndex = nextIndex;
    state.observability.lastBlockInsertAt = new Date(nowMs).toISOString();
    result.blocksIndexed += 1;
  }

  // Drained this epoch — advance to the next in the plan. Carry
  // blockIndex forward within a chain so inherited blocks aren't re-fetched,
  // but reset to 0 when crossing into a different chain so the new chain's
  // owned range starts from its block 1.
  if (state.cursor.blockIndex >= current.ownedEnd && cursorIdx < plan.length - 1) {
    const next = plan[cursorIdx + 1]!;
    const carryBlock = next.chainAnchor === current.chainAnchor ? current.ownedEnd : 0;
    log(
      `epoch ${current.epoch} (chain ${current.chainAnchor.slice(0, 8)}…) drained at ${current.ownedEnd}; advancing to ${next.epoch}`,
    );
    state.cursor = { epoch: next.epoch, blockIndex: carryBlock };
  }
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.stack ?? e.message;
  return String(e);
}

/**
 * Update {@link IndexerState.stall} from a fresh status body. Called once
 * per successful /api/v1/telemetry/status fetch.
 *
 * Bootstrapping rule: on the very first observation we set
 * `lastAdvanceAtMs = nowMs` so `isNodeStalled` can't fire on the first
 * poll after startup (we have no prior observation to compare against).
 */
export function updateStallTracker(state: IndexerState, status: StatusBody, nowMs: number): void {
  const observed = { epoch: status.latestEpoch, blockIndex: status.latestBlockIndex };
  const prev = state.stall.lastObserved;
  if (prev === null) {
    state.stall.lastObserved = observed;
    state.stall.lastAdvanceAtMs = nowMs;
    return;
  }
  const advanced = observed.epoch !== prev.epoch || observed.blockIndex !== prev.blockIndex;
  if (advanced) {
    state.stall.lastObserved = observed;
    state.stall.lastAdvanceAtMs = nowMs;
    // Clear warn throttle so a re-stall immediately re-surfaces the WARN.
    state.stall.lastWarnAtMs = 0;
  }
}

/**
 * Emit the stall WARN at most once per {@link IndexerConfig.stallWarnAfterSec}
 * window. Uses {@link isNodeStalled} (D1 decision-point) to decide whether the
 * node is actually stalled.
 */
export function maybeWarnStalled(
  state: IndexerState,
  config: IndexerConfig,
  nowMs: number,
): boolean {
  if (config.stallWarnAfterSec <= 0) return false;
  const stallMs = nowMs - state.stall.lastAdvanceAtMs;
  const thresholdMs = config.stallWarnAfterSec * 1000;
  if (!isNodeStalled(stallMs, thresholdMs)) return false;
  // Re-emit at most once per threshold window while still stalled. Operators
  // want enough signal to notice, not a fire-hose.
  const sinceLastWarnMs = nowMs - state.stall.lastWarnAtMs;
  if (state.stall.lastWarnAtMs !== 0 && sinceLastWarnMs < thresholdMs) return false;
  const obs = state.stall.lastObserved;
  warn(
    `node appears stalled at ${config.nodeUrl}: latestEpoch=${obs?.epoch ?? "?"} ` +
      `latestBlockIndex=${obs?.blockIndex ?? "?"} unchanged for ` +
      `${Math.floor(stallMs / 1000)}s (threshold ${config.stallWarnAfterSec}s)`,
  );
  state.stall.lastWarnAtMs = nowMs;
  return true;
}

/**
 * D1 (learning-mode decision point): decide whether the polled node is stalled.
 *
 * Inputs:
 *  - stallMs: wall-clock ms since latestBlockIndex last advanced
 *  - thresholdMs: configured --stall-warn-after (converted to ms)
 *
 * Trade-offs to consider:
 *  - Pure time threshold is simplest; fires on legitimately slow periods
 *    (a QPU miner alone on the network can take tens of minutes per block).
 *  - A poll-count threshold would be scale-free but fragile to poll-interval
 *    tuning.
 *  - Grace on fresh boot: lastAdvanceAtMs is seeded on first poll so we never
 *    fire before we've observed one full window — that's already handled in
 *    updateStallTracker.
 *
 * Start simple: "stallMs >= thresholdMs". Iterate once there's real data.
 *
 * TODO (learning-mode): replace this one-liner with your preferred logic.
 */
export function isNodeStalled(stallMs: number, thresholdMs: number): boolean {
  return stallMs >= thresholdMs;
}

async function refreshSelfAddress(
  db: DatabaseAdapter,
  client: QuipClient,
  snapshot: NodesSnapshot,
): Promise<void> {
  const matched = await resolveSelfAddress(client, snapshot);
  const current = await db.getSelfAddress();
  if (current !== matched) {
    await db.setSelfAddress(matched);
    if (matched) log(`self address resolved: ${matched}`);
  }
}

/**
 * Ask the node for its own peer-list address via GET /api/v1/status. The
 * node returns data.host — the exact key it uses for itself in the peer
 * list — so we can identify "us" with zero config regardless of how the
 * dashboard reaches it (docker DNS, caddy, direct IP, etc.). Returns null
 * if the node's identity isn't present in the current snapshot.
 */
export async function resolveSelfAddress(
  client: QuipClient,
  snapshot: NodesSnapshot,
): Promise<string | null> {
  const selfHost = await client.getSelfHost();
  if (!selfHost) return null;
  return snapshot.nodes[selfHost] ? selfHost : null;
}

/**
 * Fetch and cache an epoch's block-1 hash. The hash identifies the chain —
 * every epoch on the same chain shares the same block 1 because epochs
 * expose the cumulative chain history. Dead chains have distinct block-1
 * hashes from the canonical chain's block 1.
 *
 * Returns null if the node has no block 1 for this epoch yet (the epoch is
 * known but empty, e.g. just rolled over).
 */
async function ensureChainAnchor(
  client: QuipClient,
  state: IndexerState,
  epoch: EpochId,
): Promise<string | null> {
  const cached = state.chainAnchors.get(epoch);
  if (cached !== undefined) return cached;
  const raw = await client.getBlock(epoch, 1);
  if (raw === null) return null;
  const hash = String(raw.block_hash ?? "");
  if (!hash) return null;
  state.chainAnchors.set(epoch, hash);
  return hash;
}

/**
 * Build the ordered list of epochs with owned block ranges across every
 * chain the node exposes (canonical + dead). Each epoch is tagged with its
 * chain anchor (block-1 hash) so the walker can detect chain transitions
 * and reset its block cursor.
 *
 * Ownership is computed per chain: within each chain group, sort by epoch
 * ID ascending and assign (previous epoch's lastBlock + 1) .. this epoch's
 * lastBlock. Forks on the same chain where a later epoch's lastBlock is
 * ≤ the previous one (a branch that never extended the tip) get an empty
 * range and don't index any blocks — their shared prefix is already
 * covered by an earlier epoch on the same chain.
 *
 * The tip epoch (latestEpoch per /status) uses status.latestBlockIndex
 * rather than /epochs.lastBlock — the status body is the freshest source
 * for the tip, /epochs can lag by one poll cycle.
 */
export async function buildCanonicalPlan(
  client: QuipClient,
  state: IndexerState,
  status: StatusBody,
  epochsBody: EpochsBody,
): Promise<CanonicalEpoch[]> {
  if (status.latestBlockIndex <= 0) return [];

  // Include the tip epoch even if /epochs hasn't caught up to it yet.
  const byEpoch = new Map<EpochId, { epoch: EpochId; lastBlock: number }>();
  for (const e of epochsBody.epochs) {
    byEpoch.set(e.epoch, { epoch: e.epoch, lastBlock: e.lastBlock });
  }
  byEpoch.set(status.latestEpoch, {
    epoch: status.latestEpoch,
    lastBlock: status.latestBlockIndex,
  });

  // Resolve each epoch's chain anchor (block-1 hash). Empty epochs (no
  // block 1) are dropped — they contribute nothing until blocks arrive.
  const byChain = new Map<string, Array<{ epoch: EpochId; lastBlock: number }>>();
  for (const e of byEpoch.values()) {
    if (e.lastBlock <= 0) continue;
    const anchor = await ensureChainAnchor(client, state, e.epoch);
    if (!anchor) continue;
    const group = byChain.get(anchor) ?? [];
    group.push(e);
    byChain.set(anchor, group);
  }

  // Compute per-chain owned ranges. Within each chain, sort by lastBlock
  // ascending — epoch IDs are hashes now, so lastBlock is the only
  // within-chain chronology signal we have. Across chains, sort by
  // (chainAnchor, ownedStart) so same-chain epochs walk contiguously and
  // the order is deterministic for a given node view.
  const plan: CanonicalEpoch[] = [];
  for (const [chainAnchor, epochs] of byChain) {
    epochs.sort((a, b) => a.lastBlock - b.lastBlock);
    let prevLast = 0;
    for (const e of epochs) {
      plan.push({
        epoch: e.epoch,
        chainAnchor,
        ownedStart: prevLast + 1,
        ownedEnd: e.lastBlock,
      });
      if (e.lastBlock > prevLast) prevLast = e.lastBlock;
    }
  }
  plan.sort((a, b) => {
    if (a.chainAnchor !== b.chainAnchor) return a.chainAnchor < b.chainAnchor ? -1 : 1;
    return a.ownedStart - b.ownedStart;
  });
  return plan;
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
