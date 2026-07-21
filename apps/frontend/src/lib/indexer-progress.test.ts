// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { IndexerObservability } from "@quip/shared/telemetry";

import { computeIndexerProgress, LIVE_THRESHOLD } from "./indexer-progress";

const NOW = Date.parse("2026-07-04T00:00:00.000Z");

function obs(overrides: Partial<IndexerObservability> = {}): IndexerObservability {
  const now = new Date(NOW).toISOString();
  return {
    chainHeadFromNode: "559745",
    lastStatusFetchAt: now,
    lastBlockInsertAt: now,
    lastSubstrateEventAt: now,
    bestBlockHeight: "559745",
    finalizedBlockHeight: "559745",
    chainConnected: true,
    minerStats: null,
    ...overrides,
  };
}

// Build a backfill-progress object whose total missing work (summed coverage
// gapBlocks) equals `gaps`, placed on a single `winners` plugin. backfillQueueDepth
// is deliberately 0 — the indicator must ignore it (it's a bounded rolling
// window, not remaining work).
const progress = (gaps: number): NonNullable<IndexerObservability["indexer"]> => ({
  backfillQueueDepth: 0,
  coverage: {
    winners: {
      low: "394362",
      high: "560000",
      gapBlocks: gaps,
      prunedFloor: null,
      topologyEnrichmentFloor: null,
      generation: 1,
    },
  },
  difficultyDataStartBlock: null,
});

describe("computeIndexerProgress", () => {
  it("returns null when observability is absent", () => {
    expect(computeIndexerProgress(null, NOW)).toBeNull();
  });

  it("returns null when the indexer heartbeat is stale", () => {
    const stale = obs({ lastStatusFetchAt: new Date(NOW - 10 * 60_000).toISOString() });
    expect(computeIndexerProgress(stale, NOW)).toBeNull();
  });

  it("reports node-sync while the validator is syncing behind the tip", () => {
    const o = obs({
      nodeSyncing: true,
      nodeSyncCurrentBlock: "559624",
      nodeSyncHighestBlock: "559745",
    });
    expect(computeIndexerProgress(o, NOW)).toEqual({
      stage: "node-sync",
      current: 559624,
      total: 559745,
    });
  });

  it("does not report node-sync once current has reached highest", () => {
    const o = obs({
      nodeSyncing: true,
      nodeSyncCurrentBlock: "559745",
      nodeSyncHighestBlock: "559745",
      indexer: progress(0),
    });
    expect(computeIndexerProgress(o, NOW)).toBeNull();
  });

  it("reports indexing progress from chainHead minus summed coverage gapBlocks", () => {
    const o = obs({ chainHeadFromNode: "559745", indexer: progress(4145) });
    expect(computeIndexerProgress(o, NOW)).toEqual({
      stage: "indexing",
      current: 555_600,
      total: 559_745,
    });
  });

  it("treats total gaps at or below LIVE_THRESHOLD as live (null)", () => {
    const o = obs({ indexer: progress(LIVE_THRESHOLD) });
    expect(computeIndexerProgress(o, NOW)).toBeNull();
  });

  it("falls through to indexing when nodeSyncing lacks progress numbers", () => {
    const o = obs({
      nodeSyncing: true,
      nodeSyncCurrentBlock: null,
      nodeSyncHighestBlock: null,
      indexer: progress(100),
    });
    expect(computeIndexerProgress(o, NOW)).toEqual({
      stage: "indexing",
      current: 559_645,
      total: 559_745,
    });
  });

  it("returns null in the indexing branch when chainHead is unknown", () => {
    const o = obs({ chainHeadFromNode: null, indexer: progress(100) });
    expect(computeIndexerProgress(o, NOW)).toBeNull();
  });

  it("clamps current to 0 when gaps exceed chainHead", () => {
    const o = obs({ chainHeadFromNode: "50", indexer: progress(100) });
    expect(computeIndexerProgress(o, NOW)).toEqual({ stage: "indexing", current: 0, total: 50 });
  });

  it("sums gapBlocks across every coverage plugin", () => {
    const o = obs({
      chainHeadFromNode: "560000",
      indexer: {
        backfillQueueDepth: 0,
        difficultyDataStartBlock: null,
        coverage: {
          winners: {
            low: "394362",
            high: "560000",
            gapBlocks: 4000,
            prunedFloor: null,
            topologyEnrichmentFloor: null,
            generation: 1,
          },
          difficulty: {
            low: "394362",
            high: "560000",
            gapBlocks: 1500,
            prunedFloor: null,
            topologyEnrichmentFloor: null,
            generation: 1,
          },
          authorship: {
            low: "0",
            high: "560000",
            gapBlocks: 0,
            prunedFloor: null,
            topologyEnrichmentFloor: null,
            generation: 1,
          },
        },
      },
    });
    expect(computeIndexerProgress(o, NOW)).toEqual({
      stage: "indexing",
      current: 560000 - 5500,
      total: 560000,
    });
  });

  it("ignores backfillQueueDepth — zero gaps with a large queue reads as live", () => {
    const o = obs({
      indexer: { ...progress(0), backfillQueueDepth: 9999 },
    });
    expect(computeIndexerProgress(o, NOW)).toBeNull();
  });

  it("returns null when coverage is empty", () => {
    const o = obs({
      indexer: { backfillQueueDepth: 500, coverage: {}, difficultyDataStartBlock: null },
    });
    expect(computeIndexerProgress(o, NOW)).toBeNull();
  });

  it("current rises as gaps shrink (progress is visible)", () => {
    const before = computeIndexerProgress(obs({ indexer: progress(10_000) }), NOW);
    const after = computeIndexerProgress(obs({ indexer: progress(6_000) }), NOW);
    expect(before?.stage).toBe("indexing");
    expect(after?.stage).toBe("indexing");
    expect(after!.current).toBeGreaterThan(before!.current);
  });

  it("falls through to indexing when node-sync current is past highest", () => {
    const o = obs({
      nodeSyncing: true,
      nodeSyncCurrentBlock: "559800",
      nodeSyncHighestBlock: "559745",
      indexer: progress(100),
    });
    expect(computeIndexerProgress(o, NOW)).toEqual({
      stage: "indexing",
      current: 559_645,
      total: 559_745,
    });
  });

  it("returns null in the indexing branch when chainHead is non-numeric", () => {
    const o = obs({ chainHeadFromNode: "not-a-number", indexer: progress(100) });
    expect(computeIndexerProgress(o, NOW)).toBeNull();
  });
});
