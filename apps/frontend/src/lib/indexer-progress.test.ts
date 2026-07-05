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

const progress = (
  depth: number,
): NonNullable<IndexerObservability["indexer"]> => ({
  backfillQueueDepth: depth,
  coverage: {},
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

  it("reports indexing progress from chainHead minus backfill depth", () => {
    const o = obs({ chainHeadFromNode: "559745", indexer: progress(4145) });
    expect(computeIndexerProgress(o, NOW)).toEqual({
      stage: "indexing",
      current: 555_600,
      total: 559_745,
    });
  });

  it("treats a queue at or below LIVE_THRESHOLD as live (null)", () => {
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

  it("clamps current to 0 when depth exceeds chainHead", () => {
    const o = obs({ chainHeadFromNode: "50", indexer: progress(100) });
    expect(computeIndexerProgress(o, NOW)).toEqual({ stage: "indexing", current: 0, total: 50 });
  });
});
