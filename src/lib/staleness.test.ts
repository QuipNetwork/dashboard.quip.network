// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { IndexerObservability } from "../types/telemetry";

import { computeChainHealth, computeSubstrateHealth } from "./staleness";

// Shared test clock. Pinning a single `nowMs` across tests keeps thresholds
// deterministic and lets the default heartbeat in `obs()` stay fresh relative
// to this clock (so the indexer-heartbeat check doesn't fire unless a test
// opts in by setting lastStatusFetchAt explicitly).
const NOW_MS = 1_800_000_000_000;

function obs(overrides: Partial<IndexerObservability> = {}): IndexerObservability {
  return {
    chainHeadFromNode: "100",
    lastStatusFetchAt: new Date(NOW_MS - 30_000).toISOString(),
    lastBlockInsertAt: new Date(NOW_MS - 2 * 60_000).toISOString(),
    lastSubstrateEventAt: null,
    bestBlockHeight: null,
    finalizedBlockHeight: null,
    chainConnected: false,
    minerStats: null,
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
    const h = computeChainHealth({
      nowMs: NOW_MS,
      tipBlockTimestampMs: NOW_MS - 5 * 60 * 1000, // 5 minutes ago
      indexer: obs(),
    });
    expect(h.level).toBe("healthy");
  });

  it("warns when the tip is 30+ minutes old", () => {
    const h = computeChainHealth({
      nowMs: NOW_MS,
      tipBlockTimestampMs: NOW_MS - 30 * 60 * 1000,
      indexer: obs(),
    });
    expect(h.level).toBe("warning");
    expect(h.reason).toMatch(/30m/);
  });

  it("stalls when the tip is 2+ hours old", () => {
    const h = computeChainHealth({
      nowMs: NOW_MS,
      tipBlockTimestampMs: NOW_MS - 3 * 60 * 60 * 1000, // 3h
      indexer: obs(),
    });
    expect(h.level).toBe("stalled");
    expect(h.reason).toMatch(/3h/);
  });

  it("flags the indexer as wedged when lastStatusFetchAt is stale", () => {
    // Indexer process died/crashed. Tip looks recent (cached from before the
    // crash), but the heartbeat is stale. Surface the wedged indexer first
    // so operators don't chase a non-existent node-side bug.
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
    // Both conditions true (old tip AND old heartbeat). Indexer is likelier
    // culprit — reporting "node stalled" would misdirect the operator.
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
    // Guards the days branch of formatApproxDuration.
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
  it("stage='connecting' when indexer is null", () => {
    const h = computeChainHealth({ nowMs: NOW_MS, tipBlockTimestampMs: null, indexer: null });
    expect(h.stage).toBe("connecting");
    expect(h.level).toBe("healthy");
    expect(h.detail).toBe("Connecting to miner…");
  });

  it("stage='stalled' when heartbeat is stale", () => {
    const h = computeChainHealth({
      nowMs: NOW_MS,
      tipBlockTimestampMs: NOW_MS - 60_000,
      indexer: obs({ lastStatusFetchAt: new Date(NOW_MS - 6 * 60_000).toISOString() }),
    });
    expect(h.stage).toBe("stalled");
    expect(h.level).toBe("stalled");
    expect(h.detail).toMatch(/6m/);
  });

  it("stage='caught_up' when tip is current", () => {
    const h = computeChainHealth({
      nowMs: NOW_MS,
      tipBlockTimestampMs: NOW_MS - 60_000,
      indexer: obs(),
    });
    expect(h.stage).toBe("caught_up");
    expect(h.level).toBe("healthy");
    expect(h.detail).toBeNull();
  });
});

describe("computeSubstrateHealth", () => {
  it("returns 'disabled' when indexer is null", () => {
    expect(computeSubstrateHealth(null, NOW_MS).level).toBe("disabled");
  });

  it("returns 'disabled' when lastSubstrateEventAt is null", () => {
    const h = computeSubstrateHealth(obs({ lastSubstrateEventAt: null }), NOW_MS);
    expect(h.level).toBe("disabled");
  });

  it("returns 'offline' when chainConnected is false", () => {
    const h = computeSubstrateHealth(
      obs({
        lastSubstrateEventAt: new Date(NOW_MS - 5_000).toISOString(),
        chainConnected: false,
      }),
      NOW_MS,
    );
    expect(h.level).toBe("offline");
  });

  it("returns 'ok' when an event arrived within 30s and chainConnected=true", () => {
    const h = computeSubstrateHealth(
      obs({
        lastSubstrateEventAt: new Date(NOW_MS - 10_000).toISOString(),
        chainConnected: true,
      }),
      NOW_MS,
    );
    expect(h.level).toBe("ok");
    expect(h.ageMs).toBe(10_000);
  });

  it("returns 'stale' when event age is between 30s and 5m", () => {
    const h = computeSubstrateHealth(
      obs({
        lastSubstrateEventAt: new Date(NOW_MS - 60_000).toISOString(),
        chainConnected: true,
      }),
      NOW_MS,
    );
    expect(h.level).toBe("stale");
  });

  it("returns 'offline' when event age exceeds 5m", () => {
    const h = computeSubstrateHealth(
      obs({
        lastSubstrateEventAt: new Date(NOW_MS - 10 * 60_000).toISOString(),
        chainConnected: true,
      }),
      NOW_MS,
    );
    expect(h.level).toBe("offline");
  });

  it("server-anchored nowMs survives stale client clock (audit #3)", () => {
    // Simulate a backgrounded tab: client clock is 30 min ahead of the
    // server's last response time. With Date.now() as the anchor the
    // substrate event would falsely look 30 min old; with server-anchored
    // nowMs (NOW_MS, matching the recorded event time), it's fresh.
    const indexer = obs({
      lastSubstrateEventAt: new Date(NOW_MS - 5_000).toISOString(),
      chainConnected: true,
    });
    const clientClockMs = NOW_MS + 30 * 60_000;
    expect(computeSubstrateHealth(indexer, clientClockMs).level).toBe("offline");
    // But anchored to server time it stays ok.
    expect(computeSubstrateHealth(indexer, NOW_MS).level).toBe("ok");
  });
});
