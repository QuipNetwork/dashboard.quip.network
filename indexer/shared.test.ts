// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type {
  BlockRecord,
  IndexerCursor,
  IndexerObservability,
  NodesSnapshot,
  TelemetryIndex,
} from "../src/types/telemetry";
import type { DatabaseAdapter, EpochStatusEntry } from "../api/db/adapter";

import type { IndexerConfig } from "./config";
import {
  buildCanonicalPlan,
  ensureChainAnchor,
  formatErr,
  isNodeStalled,
  maybeWarnStalled,
  sleepInterruptible,
  updateStallTracker,
  type CanonicalEpoch,
  type WorkerDeps,
} from "./shared";
import { IndexerState } from "./state";

// Minimal DatabaseAdapter stub — the stall helpers never call DB methods on
// the state-held adapter; they just need `new IndexerState(db)` to succeed.
class StubDb implements DatabaseAdapter {
  async connect() {}
  async disconnect() {}
  async migrate() {}
  async insertBlock(_b: BlockRecord): Promise<boolean> {
    return true;
  }
  async getAllBlocks(): Promise<BlockRecord[]> {
    return [];
  }
  async getBlocksByEpoch(_epoch: string): Promise<BlockRecord[]> {
    return [];
  }
  async getIndex(): Promise<TelemetryIndex> {
    return { epochs: [], lastUpdated: new Date().toISOString() };
  }
  async replaceEpochStatus(_entries: EpochStatusEntry[]): Promise<void> {}
  async upsertNodes(_snapshot: NodesSnapshot): Promise<number> {
    return 0;
  }
  async getNodes(): Promise<NodesSnapshot | null> {
    return null;
  }
  async getCursors(): Promise<{ tip: IndexerCursor; backfill: IndexerCursor }> {
    return {
      tip: { epoch: null, blockIndex: 0 },
      backfill: { epoch: null, blockIndex: 0 },
    };
  }
  async saveCursors(
    _tip: IndexerCursor,
    _backfill: IndexerCursor,
    _etags: { nodes?: string | null },
  ): Promise<void> {}
  async getEtags() {
    return { nodes: null };
  }
  async setMetaRaw(_key: string, _value: string): Promise<void> {}
  async getSelfAddress(): Promise<string | null> {
    return null;
  }
  async setSelfAddress(_address: string | null): Promise<void> {}
  async getIndexerObservability(): Promise<IndexerObservability | null> {
    return null;
  }
  async setIndexerObservability(_obs: IndexerObservability): Promise<void> {}
  // v5 substrate-state stubs — never called by the stall-tracking paths
  // this stub serves, so they're no-ops that satisfy the interface.
  async upsertChainHead(): Promise<void> {}
  async getChainHead() {
    return null;
  }
  async upsertBabeEpoch(): Promise<void> {}
  async getCurrentBabeEpoch() {
    return null;
  }
  async upsertBabeAuthorities(): Promise<void> {}
  async getActiveBabeAuthorities() {
    return [];
  }
  async upsertChainMiners(): Promise<void> {}
  async getChainMiners() {
    return [];
  }
  async insertDifficultySnapshot(): Promise<void> {}
  async getRecentDifficulty() {
    return [];
  }
  async updateBlockSubstrateFields() {
    return { matched: false };
  }
  async findBlockByMinerAndEnergy() {
    return null;
  }
  async markBlocksCanonical(): Promise<void> {}
  async updateEpochChainAnchor(): Promise<void> {}
}

function makeConfig(overrides: Partial<IndexerConfig> = {}): IndexerConfig {
  return {
    nodeUrl: "https://node.example.com",
    token: undefined,
    pollIntervalSec: 8,
    nodesRefreshSec: 45,
    backfillIdleRecheckSec: 300,
    once: false,
    verbose: false,
    stallWarnAfterSec: 600,
    ...overrides,
  };
}

// Tiny synthetic StatusBody — stall tracking only reads latestEpoch and
// latestBlockIndex, so everything else can be zeroed without affecting
// behavior.
function status(latestBlockIndex: number, latestEpoch = "1000") {
  return {
    epochs: [latestEpoch],
    latestEpoch,
    latestBlockIndex,
    totalBlocks: latestBlockIndex,
    nodeCount: 0,
    activeNodeCount: 0,
    nodesUpdatedAt: null,
  };
}

describe("indexer/shared module", () => {
  it("exports expected functions and types", () => {
    expect(typeof buildCanonicalPlan).toBe("function");
    expect(typeof ensureChainAnchor).toBe("function");
    expect(typeof isNodeStalled).toBe("function");
    expect(typeof maybeWarnStalled).toBe("function");
    expect(typeof updateStallTracker).toBe("function");
    expect(typeof formatErr).toBe("function");
    // compile-time check — types only
    const _a: CanonicalEpoch = { epoch: "x", chainAnchor: "y", ownedStart: 1, ownedEnd: 2 };
    const _b: Partial<WorkerDeps> = {};
    expect(_a.epoch).toBe("x");
    expect(_b).toBeDefined();
  });

  it("isNodeStalled returns true at the exact threshold", () => {
    expect(isNodeStalled(1000, 1000)).toBe(true);
    expect(isNodeStalled(999, 1000)).toBe(false);
  });
});

describe("stall detection", () => {
  it("isNodeStalled uses >= on the threshold", () => {
    expect(isNodeStalled(599_000, 600_000)).toBe(false);
    expect(isNodeStalled(600_000, 600_000)).toBe(true);
    expect(isNodeStalled(1_000_000, 600_000)).toBe(true);
    expect(isNodeStalled(0, 0)).toBe(true); // a 0 threshold is pathological; the caller disables via stallWarnAfterSec<=0
  });

  it("updateStallTracker seeds state and does not treat first observation as an advance", () => {
    const db = new StubDb();
    const state = new IndexerState(db);
    updateStallTracker(state, status(162), 5_000);
    expect(state.stall.lastObserved).toEqual({ epoch: "1000", blockIndex: 162 });
    expect(state.stall.lastAdvanceAtMs).toBe(5_000);
  });

  it("updateStallTracker bumps lastAdvanceAtMs when latestBlockIndex changes", () => {
    const db = new StubDb();
    const state = new IndexerState(db);
    updateStallTracker(state, status(162), 1_000);
    updateStallTracker(state, status(162), 2_000); // no advance
    expect(state.stall.lastAdvanceAtMs).toBe(1_000);
    updateStallTracker(state, status(163), 3_000); // advance
    expect(state.stall.lastAdvanceAtMs).toBe(3_000);
    expect(state.stall.lastObserved).toEqual({ epoch: "1000", blockIndex: 163 });
  });

  it("updateStallTracker clears the warn throttle so re-stalls surface again", () => {
    const db = new StubDb();
    const state = new IndexerState(db);
    state.stall.lastWarnAtMs = 12_345;
    updateStallTracker(state, status(162), 0);
    updateStallTracker(state, status(163), 100); // advance clears warn throttle
    expect(state.stall.lastWarnAtMs).toBe(0);
  });

  it("maybeWarnStalled is a no-op before the threshold is crossed", () => {
    const db = new StubDb();
    const state = new IndexerState(db);
    const cfg = makeConfig({ stallWarnAfterSec: 600 });
    updateStallTracker(state, status(162), 0);
    expect(maybeWarnStalled(state, cfg, 300_000)).toBe(false); // 5 min elapsed
    expect(state.stall.lastWarnAtMs).toBe(0);
  });

  it("maybeWarnStalled fires once past threshold, then throttles until the next window", () => {
    const db = new StubDb();
    const state = new IndexerState(db);
    const cfg = makeConfig({ stallWarnAfterSec: 600 });
    updateStallTracker(state, status(162), 0);
    expect(maybeWarnStalled(state, cfg, 600_000)).toBe(true); // exactly at threshold
    expect(state.stall.lastWarnAtMs).toBe(600_000);
    // A second poll 1s later is still stalled but throttled.
    expect(maybeWarnStalled(state, cfg, 601_000)).toBe(false);
    // 10 minutes after the first warn, we re-emit.
    expect(maybeWarnStalled(state, cfg, 1_200_000)).toBe(true);
    expect(state.stall.lastWarnAtMs).toBe(1_200_000);
  });

  it("maybeWarnStalled is disabled when stallWarnAfterSec=0", () => {
    const db = new StubDb();
    const state = new IndexerState(db);
    const cfg = makeConfig({ stallWarnAfterSec: 0 });
    updateStallTracker(state, status(162), 0);
    expect(maybeWarnStalled(state, cfg, 24 * 60 * 60 * 1000)).toBe(false);
  });
});

describe("sleepInterruptible", () => {
  it("sleepInterruptible resolves immediately on abort", async () => {
    const ac = new AbortController();
    const start = Date.now();
    const p = sleepInterruptible(10_000, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await p;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // resolved well before the 10s timeout
  });

  it("sleepInterruptible resolves after ms when not aborted", async () => {
    const ac = new AbortController();
    const start = Date.now();
    await sleepInterruptible(30, ac.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25); // allow a small fudge
  });

  it("sleepInterruptible returns immediately if already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    await sleepInterruptible(10_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(20);
  });
});
