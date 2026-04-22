// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { IndexerObservability } from "../types/telemetry";

import { computeChainHealth } from "./staleness";

function obs(overrides: Partial<IndexerObservability> = {}): IndexerObservability {
  return {
    nodeLatestEpoch: 1000,
    nodeLatestBlockIndex: 10,
    cursorEpoch: 1000,
    cursorBlockIndex: 10,
    lastStatusFetchAt: "2026-04-22T12:00:00.000Z",
    lastBlockInsertAt: "2026-04-22T11:58:00.000Z",
    ...overrides,
  };
}

describe("computeChainHealth", () => {
  it("is healthy when there are no blocks yet", () => {
    const h = computeChainHealth({
      nowMs: Date.now(),
      tipBlockTimestampMs: null,
      indexer: null,
    });
    expect(h.level).toBe("healthy");
    expect(h.blockAgeMs).toBeNull();
  });

  it("is healthy when the tip is recent", () => {
    const now = 1_800_000_000_000;
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 5 * 60 * 1000, // 5 minutes ago
      indexer: obs(),
    });
    expect(h.level).toBe("healthy");
  });

  it("warns when the tip is 30+ minutes old", () => {
    const now = 1_800_000_000_000;
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 30 * 60 * 1000,
      indexer: obs(),
    });
    expect(h.level).toBe("warning");
    expect(h.reason).toMatch(/30m/);
  });

  it("stalls when the tip is 2+ hours old AND the indexer has caught up", () => {
    const now = 1_800_000_000_000;
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 3 * 60 * 60 * 1000, // 3h
      indexer: obs(), // cursor == tip
    });
    expect(h.level).toBe("stalled");
    expect(h.reason).toMatch(/3h/);
  });

  it("prefers 'indexer behind' framing when the indexer is still catching up", () => {
    // The node's reporting new blocks, the indexer just hasn't caught up.
    // This is a transient state during backfill/after restart; don't blame
    // the node.
    const now = 1_800_000_000_000;
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 3 * 60 * 60 * 1000, // 3h — would be "stalled" otherwise
      indexer: obs({ nodeLatestBlockIndex: 20, cursorBlockIndex: 17 }),
    });
    expect(h.level).toBe("warning");
    expect(h.reason).toMatch(/3 blocks behind/);
    expect(h.indexerLagBlocks).toBe(3);
  });

  it("uses singular 'block' when the indexer is exactly 1 behind", () => {
    const now = 1_800_000_000_000;
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 1000,
      indexer: obs({ nodeLatestBlockIndex: 11, cursorBlockIndex: 10 }),
    });
    expect(h.reason).toMatch(/1 block behind/);
  });

  it("does NOT compute indexer lag across different epochs", () => {
    // During an epoch transition the cursor is mid-walk; the delta between
    // nodeLatestBlockIndex and cursorBlockIndex is meaningless across epochs.
    const now = 1_800_000_000_000;
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 5 * 60 * 1000,
      indexer: obs({ nodeLatestEpoch: 2000, cursorEpoch: 1000 }),
    });
    expect(h.indexerLagBlocks).toBeNull();
  });
});
