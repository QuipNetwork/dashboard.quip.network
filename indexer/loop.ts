// SPDX-License-Identifier: AGPL-3.0-or-later

import { rawBlockToRecord, rawNodesToSnapshot, type DatabaseAdapter } from "../api/db/adapter";
import type { NodesSnapshot } from "../src/types/telemetry";

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

  // Decide the cursor epoch for this iteration.
  //
  // - Fresh boot (cursor.epoch === null):
  //     - BACKFILL_FROM_EPOCH configured: start there
  //     - otherwise: seed from the earliest epoch the node knows about so
  //       fresh deployments capture full history. /epochs failure falls back
  //       to latest rather than no-op'ing the boot.
  // - Cursor ahead of the node (epoch rolled back): reset to latest
  // - Cursor behind the node: keep walking forward through epochs
  if (state.cursor.epoch === null) {
    state.cursor = { epoch: await chooseSeedEpoch(client, config, status), blockIndex: 0 };
  } else if (state.cursor.epoch > status.latestEpoch) {
    warn(
      `cursor epoch ${state.cursor.epoch} > latestEpoch ${status.latestEpoch}; node rolled back, resetting`,
    );
    state.cursor = { epoch: status.latestEpoch, blockIndex: 0 };
  }

  const cursorEpoch = state.cursor.epoch;
  if (cursorEpoch === null) return result;

  // Work out the last block index for the current iteration's epoch.
  // In the common case we index the tip epoch and use status.latestBlockIndex.
  // During backfill (cursorEpoch < latestEpoch) we fetch /epochs to find the
  // final block of the epoch we are currently draining.
  let epochLastBlock: number;
  // When backfilling, we also use the epoch list to jump directly to the next
  // known epoch on drain. Epoch numbers are timestamps with arbitrary gaps, so
  // a cursor + 1 walk would no-op through thousands of empty epochs per hop.
  let knownEpochs: Array<{ epoch: number; lastBlock: number }> | null = null;
  if (cursorEpoch === status.latestEpoch) {
    epochLastBlock = status.latestBlockIndex;
  } else {
    const epochs = await client.getEpochs();
    knownEpochs = [...epochs.epochs].sort((a, b) => a.epoch - b.epoch);
    const match = knownEpochs.find((e) => e.epoch === cursorEpoch);
    if (!match) {
      const next = knownEpochs.find((e) => e.epoch > cursorEpoch);
      if (!next) {
        warn(`backfill: cursor epoch ${cursorEpoch} past last known epoch; waiting`);
        return result;
      }
      log(`backfill: epoch ${cursorEpoch} missing, jumping to next known epoch ${next.epoch}`);
      state.cursor = { epoch: next.epoch, blockIndex: 0 };
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
    state.observability.lastBlockInsertAt = new Date(nowMs).toISOString();
    result.blocksIndexed += 1;
  }

  // If we just finished an older epoch, advance to the next known epoch so
  // the next iteration picks up where we left off. We only advance when we
  // actually reached the end of the epoch (not on an error-break above).
  if (cursorEpoch < status.latestEpoch && state.cursor.blockIndex >= epochLastBlock) {
    const nextKnown = knownEpochs?.find((e) => e.epoch > cursorEpoch);
    const nextEpoch = nextKnown?.epoch ?? cursorEpoch + 1;
    log(
      `backfill: epoch ${cursorEpoch} complete (${epochLastBlock} blocks), advancing to ${nextEpoch}`,
    );
    state.cursor = { epoch: nextEpoch, blockIndex: 0 };
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

async function chooseSeedEpoch(
  client: QuipClient,
  config: IndexerConfig,
  status: StatusBody,
): Promise<number> {
  if (config.backfillFromEpoch !== undefined && config.backfillFromEpoch <= status.latestEpoch) {
    log(`backfill from env: starting at epoch ${config.backfillFromEpoch}`);
    return config.backfillFromEpoch;
  }
  try {
    const epochs = await client.getEpochs();
    let earliest: number | null = null;
    for (const e of epochs.epochs) {
      if (earliest === null || e.epoch < earliest) earliest = e.epoch;
    }
    if (earliest !== null) {
      log(`fresh boot: seeding from earliest known epoch ${earliest}`);
      return earliest;
    }
  } catch (e) {
    warn(`getEpochs failed on seed; falling back to latest epoch: ${formatErr(e)}`);
  }
  log(`fresh boot: no earlier epochs available, starting at ${status.latestEpoch}`);
  return status.latestEpoch;
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
