// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IndexerObservability } from "../types/telemetry";

export type HealthLevel = "healthy" | "warning" | "stalled";
export type SyncStage = "connecting" | "synchronizing" | "backfilling" | "caught_up" | "stalled";

export interface ChainHealth {
  level: HealthLevel;
  reason: string;
  stage: SyncStage;
  detail: string | null;
  blockAgeMs: number | null;
  tipLagBlocks: number | null;
}

export interface ChainHealthInputs {
  nowMs: number;
  tipBlockTimestampMs: number | null;
  indexer: IndexerObservability | null;
}

const WARN_BLOCK_AGE_MS = 30 * 60 * 1000;
const STALLED_BLOCK_AGE_MS = 2 * 60 * 60 * 1000;
const INDEXER_HEARTBEAT_STALE_MS = 5 * 60 * 1000;

// Heartbeat-stale must precede every other check because a dead indexer's
// last-written cursor can equal its last-observed node tip (= looks caught-up).
function checkHeartbeatStale(
  indexer: IndexerObservability,
  nowMs: number,
  blockAgeMs: number | null,
  tipLagBlocks: number | null,
): ChainHealth | null {
  const heartbeatMs = Date.parse(indexer.lastStatusFetchAt);
  if (!Number.isFinite(heartbeatMs)) return null;
  const heartbeatAgeMs = nowMs - heartbeatMs;
  if (heartbeatAgeMs < INDEXER_HEARTBEAT_STALE_MS) return null;
  const mins = Math.max(1, Math.floor(heartbeatAgeMs / 60_000));
  return {
    level: "stalled",
    reason: `Dashboard indexer hasn't polled the node in ${formatApproxDuration(heartbeatAgeMs)}.`,
    stage: "stalled",
    detail: `${mins}m`,
    blockAgeMs,
    tipLagBlocks,
  };
}

function checkTipSync(
  indexer: IndexerObservability,
  blockAgeMs: number | null,
  tipLagBlocks: number | null,
): ChainHealth | null {
  if (indexer.tipEpoch !== null && indexer.tipEpoch !== indexer.nodeLatestEpoch) {
    return {
      level: "warning",
      reason: "Indexer catching up to a new epoch from the node.",
      stage: "synchronizing",
      detail: "Catching up to new epoch",
      blockAgeMs,
      tipLagBlocks: null,
    };
  }
  if (tipLagBlocks !== null && tipLagBlocks > 0) {
    return {
      level: "warning",
      reason: `Indexer is ${tipLagBlocks} block${tipLagBlocks === 1 ? "" : "s"} behind the polled node.`,
      stage: "synchronizing",
      detail: `${tipLagBlocks} block${tipLagBlocks === 1 ? "" : "s"} behind`,
      blockAgeMs,
      tipLagBlocks,
    };
  }
  return null;
}

// Clock-skew handling: require a finite, non-negative blockAgeMs before
// escalating. The *indexer* is fine here; the node just isn't producing.
function checkCaughtUpBlockAge(
  blockAgeMs: number | null,
  tipLagBlocks: number | null,
): ChainHealth | null {
  if (blockAgeMs === null || !Number.isFinite(blockAgeMs) || blockAgeMs < 0) {
    return null;
  }
  if (blockAgeMs >= STALLED_BLOCK_AGE_MS) {
    return {
      level: "stalled",
      reason: `Polled node hasn't seen a block in ${formatApproxDuration(blockAgeMs)}.`,
      stage: "caught_up",
      detail: null,
      blockAgeMs,
      tipLagBlocks,
    };
  }
  if (blockAgeMs >= WARN_BLOCK_AGE_MS) {
    return {
      level: "warning",
      reason: `Last block was ${formatApproxDuration(blockAgeMs)} ago.`,
      stage: "caught_up",
      detail: null,
      blockAgeMs,
      tipLagBlocks,
    };
  }
  return null;
}

export function computeChainHealth(inputs: ChainHealthInputs): ChainHealth {
  const { nowMs, tipBlockTimestampMs, indexer } = inputs;
  const blockAgeMs = tipBlockTimestampMs !== null ? nowMs - tipBlockTimestampMs : null;
  const sameEpoch = indexer !== null && indexer.tipEpoch === indexer.nodeLatestEpoch;
  const tipLagBlocks =
    indexer !== null && sameEpoch ? indexer.nodeLatestBlockIndex - indexer.tipBlockIndex : null;

  // 1. Connecting — no poll has completed yet.
  if (indexer === null) {
    return {
      level: "healthy",
      reason: "",
      stage: "connecting",
      detail: "Connecting to node…",
      blockAgeMs,
      tipLagBlocks: null,
    };
  }

  // 2. Heartbeat-stale must precede every other check — a dead indexer's
  //    last-written cursor can equal its last-observed node tip (looks caught-up).
  const stalled = checkHeartbeatStale(indexer, nowMs, blockAgeMs, tipLagBlocks);
  if (stalled) return stalled;

  // 3. Tip still catching up (either epoch mismatch or same-epoch block lag).
  const syncing = checkTipSync(indexer, blockAgeMs, tipLagBlocks);
  if (syncing) return syncing;

  // 4. Backfill in flight — tip is caught up, historical work pending.
  if (indexer.backfillEpoch !== null) {
    return {
      level: "healthy",
      reason: "",
      stage: "backfilling",
      detail: null,
      blockAgeMs,
      tipLagBlocks,
    };
  }

  // 5. Tip caught up, backfill idle. Escalate level on block-age thresholds.
  const ageEscalated = checkCaughtUpBlockAge(blockAgeMs, tipLagBlocks);
  if (ageEscalated) return ageEscalated;

  return {
    level: "healthy",
    reason: "",
    stage: "caught_up",
    detail: null,
    blockAgeMs,
    tipLagBlocks,
  };
}

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
