// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { IndexerObservability } from "../types/telemetry";

import { computeChainHealth } from "./staleness";

// Shared test clock. Pinning a single `nowMs` across tests keeps thresholds
// deterministic and lets the default heartbeat in `obs()` stay fresh relative
// to this clock (so the indexer-heartbeat check doesn't fire unless a test
// opts in by setting lastStatusFetchAt explicitly).
const NOW_MS = 1_800_000_000_000;

function obs(overrides: Partial<IndexerObservability> = {}): IndexerObservability {
  return {
    nodeLatestEpoch: "1000",
    nodeLatestBlockIndex: 10,
    tipEpoch: "1000",
    tipBlockIndex: 10,
    backfillEpoch: null,
    backfillBlockIndex: 0,
    lastStatusFetchAt: new Date(NOW_MS - 30_000).toISOString(),
    lastBlockInsertAt: new Date(NOW_MS - 2 * 60_000).toISOString(),
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
      indexer: obs({ nodeLatestBlockIndex: 20, tipBlockIndex: 17 }),
    });
    expect(h.level).toBe("warning");
    expect(h.reason).toMatch(/3 blocks behind/);
    expect(h.tipLagBlocks).toBe(3);
  });

  it("uses singular 'block' when the indexer is exactly 1 behind", () => {
    const now = 1_800_000_000_000;
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 1000,
      indexer: obs({ nodeLatestBlockIndex: 11, tipBlockIndex: 10 }),
    });
    expect(h.reason).toMatch(/1 block behind/);
  });

  it("does NOT compute indexer lag across different epochs", () => {
    // During an epoch transition the cursor is mid-walk; the delta between
    // nodeLatestBlockIndex and tipBlockIndex is meaningless across epochs.
    const now = 1_800_000_000_000;
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 5 * 60 * 1000,
      indexer: obs({ nodeLatestEpoch: "2000", tipEpoch: "1000" }),
    });
    expect(h.tipLagBlocks).toBeNull();
  });

  it("attributes cross-epoch lag to the indexer, not the node", () => {
    // User-reported scenario: node is fresh (producing blocks now), but the
    // indexer is stuck in an older epoch so the newest stored block is days
    // old. Previously the banner read "Polled node hasn't seen a block in 5d
    // 2h" — misleading, since the node is fine. Expect the indexer-framed
    // warning instead. Post-v4 epochs are hashes so we can only say the
    // indexer is "on a different epoch", not a numeric distance.
    const now = 1_800_000_000_000;
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 5 * 24 * 60 * 60 * 1000, // 5 days — would be "stalled" otherwise
      indexer: obs({ nodeLatestEpoch: "1005", tipEpoch: "1000" }),
    });
    expect(h.level).toBe("warning");
    expect(h.reason).toMatch(/new epoch/);
  });

  it("does not warn about differing epochs before the cursor has seeded", () => {
    // Fresh indexer: tipEpoch is null until the first successful poll.
    const now = 1_800_000_000_000;
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 60_000,
      indexer: obs({ tipEpoch: null }),
    });
    expect(h.reason).not.toMatch(/new epoch/);
  });

  it("flags the indexer as wedged when lastStatusFetchAt is stale", () => {
    // Indexer process died/crashed. cursor matches node (caught up), tip is
    // recent. Without the heartbeat check we'd miss this entirely — the UI
    // would keep showing healthy while the dashboard silently freezes.
    const h = computeChainHealth({
      nowMs: NOW_MS,
      tipBlockTimestampMs: NOW_MS - 60_000,
      indexer: obs({ lastStatusFetchAt: new Date(NOW_MS - 6 * 60_000).toISOString() }),
    });
    expect(h.level).toBe("stalled");
    expect(h.reason).toMatch(/Dashboard indexer hasn't polled/);
    expect(h.reason).toMatch(/6m/);
  });

  it("prefers indexer-wedged framing over node-stalled", () => {
    // Both conditions are true (old tip AND old heartbeat). The indexer is
    // the likelier culprit — reporting "node stalled" would misdirect the
    // operator to debug the wrong component.
    const h = computeChainHealth({
      nowMs: NOW_MS,
      tipBlockTimestampMs: NOW_MS - 3 * 60 * 60 * 1000, // 3h
      indexer: obs({ lastStatusFetchAt: new Date(NOW_MS - 30 * 60_000).toISOString() }),
    });
    expect(h.level).toBe("stalled");
    expect(h.reason).toMatch(/indexer hasn't polled/);
  });

  it("does not flag the indexer when the heartbeat is just barely under the threshold", () => {
    // 4m 59s is within the 5m grace window — well above the ~8s poll cadence.
    const h = computeChainHealth({
      nowMs: NOW_MS,
      tipBlockTimestampMs: NOW_MS - 60_000,
      indexer: obs({
        lastStatusFetchAt: new Date(NOW_MS - (5 * 60_000 - 1000)).toISOString(),
      }),
    });
    expect(h.level).toBe("healthy");
  });

  it("tolerates an unparseable lastStatusFetchAt by skipping the heartbeat check", () => {
    // Defensive: a garbage heartbeat string shouldn't kill the endpoint or
    // show a confusing banner. Fall through to the other branches.
    const h = computeChainHealth({
      nowMs: NOW_MS,
      tipBlockTimestampMs: NOW_MS - 60_000,
      indexer: obs({ lastStatusFetchAt: "not a date" }),
    });
    expect(h.level).toBe("healthy");
  });

  it("stalls exactly at the 2h threshold", () => {
    // Boundary: inverting the >= in the stalled branch would pass tests that
    // only exercise 3h. Pin the exact threshold behaviour.
    const h = computeChainHealth({
      nowMs: NOW_MS,
      tipBlockTimestampMs: NOW_MS - 2 * 60 * 60 * 1000,
      indexer: obs(),
    });
    expect(h.level).toBe("stalled");
  });

  it("formats multi-day staleness as '5d 2h'", () => {
    // Guards the days branch of formatApproxDuration — otherwise covered only
    // by computed code paths where the test might not inspect the reason.
    const h = computeChainHealth({
      nowMs: NOW_MS,
      tipBlockTimestampMs: NOW_MS - (5 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000),
      indexer: obs(),
    });
    expect(h.level).toBe("stalled");
    expect(h.reason).toMatch(/5d 2h/);
  });

  it("is healthy when the tip timestamp is in the future (clock skew)", () => {
    // blockAgeMs goes negative. Neither "stalled" nor "warning" should fire —
    // a future-dated tip is almost always a client clock problem, not a node
    // fault, and the user shouldn't see a scary banner because of it.
    const h = computeChainHealth({
      nowMs: NOW_MS,
      tipBlockTimestampMs: NOW_MS + 60_000,
      indexer: obs(),
    });
    expect(h.level).toBe("healthy");
    expect(h.blockAgeMs).toBeLessThan(0);
  });
});

describe("computeChainHealth — stage derivation", () => {
  const now = 1_800_000_000_000;

  it("stage='connecting' when indexer is null", () => {
    const h = computeChainHealth({ nowMs: now, tipBlockTimestampMs: null, indexer: null });
    expect(h.stage).toBe("connecting");
    expect(h.level).toBe("healthy");
    expect(h.detail).toBe("Connecting to node…");
  });

  it("stage='stalled' when heartbeat is stale", () => {
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 60_000,
      indexer: obs({ lastStatusFetchAt: new Date(now - 6 * 60_000).toISOString() }),
    });
    expect(h.stage).toBe("stalled");
    expect(h.level).toBe("stalled");
    expect(h.detail).toMatch(/6m/);
  });

  it("stage='synchronizing' + detail='N blocks behind' when tip lags on same epoch", () => {
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 60_000,
      indexer: obs({ nodeLatestBlockIndex: 25, tipBlockIndex: 11 }),
    });
    expect(h.stage).toBe("synchronizing");
    expect(h.detail).toBe("14 blocks behind");
    expect(h.tipLagBlocks).toBe(14);
  });

  it("stage='synchronizing' + detail='Catching up to new epoch' on epoch mismatch", () => {
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 60_000,
      indexer: obs({ nodeLatestEpoch: "newA", tipEpoch: "oldB" }),
    });
    expect(h.stage).toBe("synchronizing");
    expect(h.detail).toBe("Catching up to new epoch");
    expect(h.tipLagBlocks).toBeNull();
  });

  it("stage='backfilling' when tip is caught up but backfill is running", () => {
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 60_000,
      indexer: obs({ backfillEpoch: "some-epoch", backfillBlockIndex: 5 }),
    });
    expect(h.stage).toBe("backfilling");
    expect(h.level).toBe("healthy");
    expect(h.detail).toBeNull();
  });

  it("stage='caught_up' when tip current and backfill idle", () => {
    const h = computeChainHealth({
      nowMs: now,
      tipBlockTimestampMs: now - 60_000,
      indexer: obs(),
    });
    expect(h.stage).toBe("caught_up");
    expect(h.level).toBe("healthy");
    expect(h.detail).toBeNull();
  });
});
