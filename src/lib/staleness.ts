// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IndexerObservability } from "@/types/telemetry";

export type HealthLevel = "healthy" | "warning" | "stalled";
export type SyncStage = "connecting" | "caught_up" | "stalled";

/** Substrate worker health (separate dimension from REST chain health). */
export type SubstrateHealthLevel = "disabled" | "ok" | "stale" | "offline";

export interface SubstrateHealth {
  level: SubstrateHealthLevel;
  ageMs: number | null;
  reason: string;
}

// Substrate event freshness windows. Tighter than the REST heartbeat
// thresholds because finalized heads arrive every ~6s on quip-protocol-rs.
const SUBSTRATE_OK_WINDOW_MS = 30_000;
const SUBSTRATE_STALE_WINDOW_MS = 5 * 60 * 1000;

export interface ChainHealth {
  level: HealthLevel;
  reason: string;
  stage: SyncStage;
  detail: string | null;
  blockAgeMs: number | null;
}

export interface ChainHealthInputs {
  nowMs: number;
  tipBlockTimestampMs: number | null;
  indexer: IndexerObservability | null;
}

const WARN_BLOCK_AGE_MS = 30 * 60 * 1000;
const STALLED_BLOCK_AGE_MS = 2 * 60 * 60 * 1000;
const INDEXER_HEARTBEAT_STALE_MS = 5 * 60 * 1000;

// Heartbeat-stale must precede the block-age check because a dead indexer
// can leave a fresh-looking tip in the cached telemetry response. Surface the
// wedged indexer first so operators debug the right component.
function checkHeartbeatStale(
  indexer: IndexerObservability,
  nowMs: number,
  blockAgeMs: number | null,
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
  };
}

// Clock-skew handling: require a finite, non-negative blockAgeMs before
// escalating. The *indexer* is fine here; the node just isn't producing.
function checkCaughtUpBlockAge(blockAgeMs: number | null): ChainHealth | null {
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
    };
  }
  if (blockAgeMs >= WARN_BLOCK_AGE_MS) {
    return {
      level: "warning",
      reason: `Last block was ${formatApproxDuration(blockAgeMs)} ago.`,
      stage: "caught_up",
      detail: null,
      blockAgeMs,
    };
  }
  return null;
}

/**
 * Compute chain health from the v0.3 IndexerObservability shape.
 *
 * v0.3 removed the dual-cursor (`tipEpoch`/`nodeLatestEpoch`) model — the
 * substrate worker is the sole block writer, so there's no longer a
 * meaningful "indexer is N blocks behind the node" dimension. Health
 * collapses to two checks:
 *
 *   1. Is the indexer process alive? (heartbeat from `lastStatusFetchAt`)
 *   2. Is the chain producing? (`blockAgeMs` from the latest stored block)
 *
 * Heartbeat-stale wins ties — a wedged indexer with a recent cached tip
 * could otherwise hide behind "healthy".
 */
export function computeChainHealth(inputs: ChainHealthInputs): ChainHealth {
  const { nowMs, tipBlockTimestampMs, indexer } = inputs;
  const blockAgeMs = tipBlockTimestampMs !== null ? nowMs - tipBlockTimestampMs : null;

  // 1. Connecting — no poll has completed yet.
  if (indexer === null) {
    return {
      level: "healthy",
      reason: "",
      stage: "connecting",
      detail: "Connecting to miner…",
      blockAgeMs,
    };
  }

  // 2. Heartbeat-stale must precede every other check — a dead indexer's
  //    cached response can show a fresh tip from before it died.
  const stalled = checkHeartbeatStale(indexer, nowMs, blockAgeMs);
  if (stalled) return stalled;

  // 3. Tip caught up; escalate level on block-age thresholds.
  const ageEscalated = checkCaughtUpBlockAge(blockAgeMs);
  if (ageEscalated) return ageEscalated;

  return {
    level: "healthy",
    reason: "",
    stage: "caught_up",
    detail: null,
    blockAgeMs,
  };
}

/**
 * Compute substrate-worker health. Three-tier:
 *
 *   - "disabled": no validator endpoint usable by the indexer — the worker
 *     was never started, so the UI hides the substrate dot entirely.
 *   - "ok": A substrate event arrived within 30s and the socket is live.
 *   - "stale": Last event > 30s but < 5m ago (transient slowdown).
 *   - "offline": Either chainConnected=false, or last event > 5m ago.
 *
 * `nowMs` is server-anchored (see selectServerNowMs) so backgrounded tabs
 * don't show inflated ages.
 */
export function computeSubstrateHealth(
  indexer: IndexerObservability | null,
  nowMs: number,
): SubstrateHealth {
  if (!indexer || indexer.lastSubstrateEventAt === null) {
    return { level: "disabled", ageMs: null, reason: "" };
  }
  if (!indexer.chainConnected) {
    return {
      level: "offline",
      ageMs: null,
      reason: "Substrate validator RPC disconnected",
    };
  }
  const lastMs = Date.parse(indexer.lastSubstrateEventAt);
  if (!Number.isFinite(lastMs)) {
    return { level: "offline", ageMs: null, reason: "Substrate timestamp unparseable" };
  }
  const ageMs = nowMs - lastMs;
  if (ageMs < SUBSTRATE_OK_WINDOW_MS) {
    return { level: "ok", ageMs, reason: "" };
  }
  if (ageMs < SUBSTRATE_STALE_WINDOW_MS) {
    return {
      level: "stale",
      ageMs,
      reason: `No substrate event in ${formatApproxDuration(ageMs)}`,
    };
  }
  return {
    level: "offline",
    ageMs,
    reason: `No substrate event in ${formatApproxDuration(ageMs)}`,
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
