// SPDX-License-Identifier: AGPL-3.0-or-later

import { computeChainHealth } from "@/lib/staleness";
import type { IndexerObservability } from "@quip/shared/telemetry";

// backfillQueueDepth ticks to ~1 on each new live block (the tip bucket), so a
// strict `> 0` test would keep the indicator visible during normal operation
// and never reach the hidden "live" state. Treat a queue at/below this as
// routine live churn, not catch-up.
export const LIVE_THRESHOLD = 2;

export type IndexerProgress =
  | { stage: "node-sync"; current: number; total: number }
  | { stage: "indexing"; current: number; total: number };

// Block heights are u64-as-string; on this chain they are far below
// Number.MAX_SAFE_INTEGER, so Number() is safe for display math.
function toBlockNum(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Two-stage indexer progress for the header line under Connected Miner.
 *
 * 1. node-sync — the connected validator is still importing blocks
 *    (nodeSyncing, current < highest).
 * 2. indexing — the dashboard's own backfill is catching up
 *    (backfillQueueDepth above LIVE_THRESHOLD).
 *
 * Returns null when there is nothing to show: no observability, a wedged/stale
 * indexer (the SyncIndicator owns that "offline" messaging), or fully live.
 */
export function computeIndexerProgress(
  indexer: IndexerObservability | null,
  nowMs: number,
): IndexerProgress | null {
  if (indexer === null) return null;

  // A wedged indexer can leave fresh-looking numbers in the cached response;
  // reuse the exact heartbeat-stale rule (only that check yields "stalled").
  if (computeChainHealth({ nowMs, tipBlockTimestampMs: null, indexer }).stage === "stalled") {
    return null;
  }

  // Stage 1: validator node sync.
  if (indexer.nodeSyncing === true) {
    const current = toBlockNum(indexer.nodeSyncCurrentBlock);
    const total = toBlockNum(indexer.nodeSyncHighestBlock);
    if (current !== null && total !== null && current < total) {
      return { stage: "node-sync", current, total };
    }
  }

  // Stage 2: dashboard indexer backfill (approach A: remaining-based).
  const depth = indexer.indexer?.backfillQueueDepth;
  const total = toBlockNum(indexer.chainHeadFromNode);
  if (typeof depth === "number" && depth > LIVE_THRESHOLD && total !== null) {
    // The `Math.min(total, …)` upper bound is unreachable here (depth is
    // always > 0 due to the LIVE_THRESHOLD gate above, so total - depth < total),
    // but it keeps the result provably within [0, total] per spec.
    const current = Math.min(total, Math.max(0, total - depth));
    return { stage: "indexing", current, total };
  }

  return null;
}
