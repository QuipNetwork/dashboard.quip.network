// SPDX-License-Identifier: AGPL-3.0-or-later

import { rawBlockToRecord, rawNodesToSnapshot, type DatabaseAdapter } from "../api/db/adapter";
import type { NodesSnapshot } from "../src/types/telemetry";

import { AuthError, QuipClient, RateLimitError, type EpochsBody, type StatusBody } from "./client";
import type { IndexerConfig } from "./config";
import { IndexerState } from "./state";

/**
 * A canonical-chain epoch annotated with the block range it OWNS — the slice
 * of the chain that was first introduced during this epoch.
 *
 * Quip epochs carry the full chain history up to the epoch's tip, so the
 * same block_index can appear under multiple epoch URLs. Owned ranges
 * disambiguate: each block is attributed to exactly one canonical epoch,
 * the earliest one where it appeared.
 *
 *   ownedStart = (previous canonical epoch's lastBlock) + 1  (or 1 for the
 *                first canonical epoch)
 *   ownedEnd   = this epoch's lastBlock (or status.latestBlockIndex for the
 *                tip, which is fresher than /epochs)
 */
export interface CanonicalEpoch {
  epoch: number;
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
    const next = plan.find((e) => e.epoch > (state.cursor.epoch ?? 0));
    if (!next) {
      warn(
        `cursor epoch ${state.cursor.epoch} is not canonical and has no canonical successor; waiting`,
      );
      return;
    }
    warn(
      `cursor epoch ${state.cursor.epoch} is not on the canonical chain; advancing to ${next.epoch}`,
    );
    state.cursor = { epoch: next.epoch, blockIndex: 0 };
    cursorIdx = plan.findIndex((e) => e.epoch === next.epoch);
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

  // Drained this canonical epoch — advance to the next. Cursor.blockIndex
  // stays at current.ownedEnd so the next iteration's clamp bumps it to
  // the next epoch's (ownedStart - 1) without re-fetching anything.
  if (state.cursor.blockIndex >= current.ownedEnd && cursorIdx < plan.length - 1) {
    const next = plan[cursorIdx + 1]!;
    log(
      `canonical: epoch ${current.epoch} drained at ${current.ownedEnd}; advancing to ${next.epoch}`,
    );
    state.cursor = { epoch: next.epoch, blockIndex: current.ownedEnd };
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
  epoch: number,
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
 * Build the ordered list of canonical-chain epochs with owned block ranges.
 *
 * Canonical chain = the chain whose block-1 hash matches that of
 * status.latestEpoch (the tip the node is currently extending). Every other
 * epoch the node knows about is a dead fork and gets skipped — we never
 * index its blocks.
 *
 * Within the canonical chain, each epoch's owned range is the slice of the
 * chain introduced during that epoch: (previous canonical epoch's lastBlock
 * + 1) through this epoch's lastBlock. The tip epoch uses
 * status.latestBlockIndex instead of /epochs.lastBlock because the former is
 * authoritative for "how far the chain has advanced" while the latter can
 * lag by one poll cycle.
 */
export async function buildCanonicalPlan(
  client: QuipClient,
  state: IndexerState,
  status: StatusBody,
  epochsBody: EpochsBody,
): Promise<CanonicalEpoch[]> {
  if (status.latestBlockIndex <= 0) return [];
  const canonicalAnchor = await ensureChainAnchor(client, state, status.latestEpoch);
  if (!canonicalAnchor) return [];

  // Include the tip epoch even if /epochs hasn't caught up to it yet — the
  // node's status body is fresher. Build a union {tip} ∪ /epochs.epochs,
  // deduplicated, sorted ascending.
  const byEpoch = new Map<number, { epoch: number; lastBlock: number }>();
  for (const e of epochsBody.epochs) {
    byEpoch.set(e.epoch, { epoch: e.epoch, lastBlock: e.lastBlock });
  }
  // Tip override: use status.latestBlockIndex for the current tip epoch.
  byEpoch.set(status.latestEpoch, {
    epoch: status.latestEpoch,
    lastBlock: status.latestBlockIndex,
  });
  const sorted = [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);

  const plan: CanonicalEpoch[] = [];
  let prevLast = 0;
  for (const e of sorted) {
    const anchor = await ensureChainAnchor(client, state, e.epoch);
    if (anchor !== canonicalAnchor) continue;
    plan.push({
      epoch: e.epoch,
      ownedStart: prevLast + 1,
      ownedEnd: e.lastBlock,
    });
    prevLast = e.lastBlock;
  }
  return plan;
}

/**
 * Pick the initial cursor epoch for a fresh boot. If
 * `config.backfillFromEpoch` is set and that epoch is canonical, honor it;
 * otherwise start from the earliest canonical epoch so the full chain gets
 * indexed.
 */
function chooseCanonicalSeed(plan: CanonicalEpoch[], config: IndexerConfig): number {
  const first = plan[0]!;
  const configured = config.backfillFromEpoch;
  if (configured === undefined) return first.epoch;
  const match = plan.find((e) => e.epoch === configured);
  if (match) return configured;
  warn(`BACKFILL_FROM_EPOCH=${configured} is not canonical; seeding from ${first.epoch} instead`);
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
