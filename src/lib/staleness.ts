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

  // If the indexer is lagging the node but the node IS producing blocks,
  // prefer that framing over "chain is stalled".
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
