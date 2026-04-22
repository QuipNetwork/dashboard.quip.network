// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IndexerObservability } from "../types/telemetry";

export type HealthLevel = "healthy" | "warning" | "stalled";

/**
 * Result returned by {@link computeChainHealth}. The banner component in
 * RecentBlocksTable renders differently per level.
 */
export interface ChainHealth {
  level: HealthLevel;
  // Human-readable explanation. Safe to drop directly into the banner.
  reason: string;
  // ms since the tip block's timestamp. null when the chain is empty.
  blockAgeMs: number | null;
  // node's latestBlockIndex minus indexer's cursorBlockIndex. null when
  // observability is not yet written.
  indexerLagBlocks: number | null;
}

export interface ChainHealthInputs {
  // Wall-clock ms at the moment this was evaluated (accept as a param so
  // the UI can pass a throttled clock for tests and stable re-renders).
  nowMs: number;
  // ms of the tip block's timestamp. null when there are no blocks yet.
  tipBlockTimestampMs: number | null;
  // Latest indexer snapshot, null before the first poll after deploy.
  indexer: IndexerObservability | null;
}

// Default thresholds. Tuned for Quip: QPU blocks can legitimately take
// 20-30 minutes, so "warning" starts after 30 minutes and "stalled" only
// after the tip is genuinely old AND the indexer has caught up to the
// node (i.e. the node itself isn't producing blocks).
const WARN_BLOCK_AGE_MS = 30 * 60 * 1000; // 30 minutes
const STALLED_BLOCK_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// If the indexer's lastStatusFetchAt heartbeat is older than this, the
// indexer process is wedged or dead. Default poll cadence is 8s, so five
// minutes is ~37 polls of grace — well past transient hiccups but short
// enough that operators see the problem before blaming the node.
const INDEXER_HEARTBEAT_STALE_MS = 5 * 60 * 1000;

/**
 * D2 (learning-mode decision point): map observability + tip-block age into
 * a three-state health level for the UI banner.
 *
 * Trade-offs to consider:
 *
 * - **Fixed thresholds** (below) are simple and deterministic. Easy to tune
 *   once real data shows up.
 * - **Adaptive thresholds** (e.g. 3x the recent median inter-block interval)
 *   self-calibrate to the network's actual rate, but over-fit to recent
 *   weirdness and are harder to explain in a tooltip.
 * - **Pure block-age vs. indexer-vs-node gap**: block-age catches the
 *   "network stopped producing" case; indexer-gap catches "indexer is
 *   behind but the node is fine". The banner should distinguish these — a
 *   user who sees "indexer is 3 blocks behind" knows to wait, whereas
 *   "node hasn't advanced in 14h" is a real problem.
 *
 * Start simple: fixed thresholds on block age, with "stalled" requiring
 * the indexer to have caught up (so we don't blame the node for indexer
 * lag). Iterate once there's real data.
 *
 * TODO (learning-mode): tailor thresholds and logic to your preferences.
 */
export function computeChainHealth(inputs: ChainHealthInputs): ChainHealth {
  const { nowMs, tipBlockTimestampMs, indexer } = inputs;
  const blockAgeMs = tipBlockTimestampMs !== null ? nowMs - tipBlockTimestampMs : null;
  const indexerLagBlocks =
    indexer !== null && indexer.cursorEpoch === indexer.nodeLatestEpoch
      ? indexer.nodeLatestBlockIndex - indexer.cursorBlockIndex
      : null;

  if (blockAgeMs === null) {
    return { level: "healthy", reason: "No blocks yet.", blockAgeMs, indexerLagBlocks };
  }

  // Indexer heartbeat. If lastStatusFetchAt hasn't advanced in minutes the
  // indexer process is wedged/dead and the downstream "node hasn't seen a
  // block" branch would misattribute the stall to the node. This precedes
  // the epoch/block-lag checks because a dead indexer can also appear
  // caught-up (its last-written cursor equals its last-observed nodeLatest*).
  if (indexer !== null) {
    const heartbeatMs = Date.parse(indexer.lastStatusFetchAt);
    if (Number.isFinite(heartbeatMs)) {
      const heartbeatAgeMs = nowMs - heartbeatMs;
      if (heartbeatAgeMs >= INDEXER_HEARTBEAT_STALE_MS) {
        return {
          level: "stalled",
          reason: `Dashboard indexer hasn't polled the node in ${formatApproxDuration(heartbeatAgeMs)}.`,
          blockAgeMs,
          indexerLagBlocks,
        };
      }
    }
  }

  // Clock skew / malformed tip timestamps produce negative or non-finite
  // blockAgeMs. Don't trip "stalled" on those — a future-dated tip is
  // usually the dashboard's clock drifting, not the node failing.
  if (!Number.isFinite(blockAgeMs) || blockAgeMs < 0) {
    return { level: "healthy", reason: "", blockAgeMs, indexerLagBlocks };
  }

  // Indexer is in an older epoch than the node — it's either still
  // backfilling, restarted, or wedged. Without this branch we'd fall through
  // to "stalled" and blame the node for an indexer-side lag: the tip block in
  // the store is the newest row the indexer has managed to write, not the
  // newest block the node has produced. A null cursorEpoch means the indexer
  // hasn't seeded yet; we can't compute a meaningful delta and leave the
  // banner to the downstream branches.
  if (
    indexer !== null &&
    indexer.cursorEpoch !== null &&
    indexer.cursorEpoch < indexer.nodeLatestEpoch
  ) {
    const behindEpochs = indexer.nodeLatestEpoch - indexer.cursorEpoch;
    return {
      level: "warning",
      reason: `Indexer is ${behindEpochs} epoch${behindEpochs === 1 ? "" : "s"} behind the polled node.`,
      blockAgeMs,
      indexerLagBlocks: null,
    };
  }

  // Same-epoch lag: the indexer has reached the current epoch but hasn't
  // picked up every block in it yet.
  if (indexerLagBlocks !== null && indexerLagBlocks > 0) {
    return {
      level: "warning",
      reason: `Indexer is ${indexerLagBlocks} block${indexerLagBlocks === 1 ? "" : "s"} behind the polled node.`,
      blockAgeMs,
      indexerLagBlocks,
    };
  }

  if (blockAgeMs >= STALLED_BLOCK_AGE_MS) {
    return {
      level: "stalled",
      reason: `Polled node hasn't seen a block in ${formatApproxDuration(blockAgeMs)}.`,
      blockAgeMs,
      indexerLagBlocks,
    };
  }
  if (blockAgeMs >= WARN_BLOCK_AGE_MS) {
    return {
      level: "warning",
      reason: `Last block was ${formatApproxDuration(blockAgeMs)} ago.`,
      blockAgeMs,
      indexerLagBlocks,
    };
  }
  return { level: "healthy", reason: "", blockAgeMs, indexerLagBlocks };
}

// Approx, human-friendly — "2h 15m" rather than exact seconds. Kept here
// (not src/lib/format.ts) because formatDuration there is used in a
// monospace tabular context and rounds differently.
function formatApproxDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}
