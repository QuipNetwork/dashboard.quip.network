// SPDX-License-Identifier: AGPL-3.0-or-later

import { computeChainHealth } from "@/lib/staleness";
import type { IndexerObservability } from "@quip/shared/telemetry";

// A healthy, fully-backfilled deployment reports 0 gapBlocks for every plugin,
// so anything above this small threshold means real catch-up work remains. The
// slack absorbs the odd transient failed/pending-retry block without pinning
// the indicator open.
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
 * 2. indexing — the dashboard's own backfill is catching up (summed coverage
 *    gapBlocks above LIVE_THRESHOLD).
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

  // Stage 2: dashboard indexer backfill. Remaining work is the summed per-plugin
  // coverage `gapBlocks` (failed/pending-retry blocks still missing). This is the
  // TRUE deficit and shrinks as the backfill closes gaps. It deliberately ignores
  // `backfillQueueDepth`, which is a bounded rolling in-flight window the coverage
  // walker keeps topped up — so it stays ~constant while real progress happens
  // and never appeared to move (verified against the live stack, 2026-07-04).
  const coverage = indexer.indexer?.coverage;
  const total = toBlockNum(indexer.chainHeadFromNode);
  if (coverage && total !== null) {
    const gaps = Object.values(coverage).reduce((sum, c) => sum + c.gapBlocks, 0);
    if (gaps > LIVE_THRESHOLD) {
      // gaps ≥ 0, so total - gaps ≤ total; clamp the underflow (gaps > total).
      const current = Math.max(0, total - gaps);
      return { stage: "indexing", current, total };
    }
  }

  return null;
}
