// SPDX-License-Identifier: AGPL-3.0-or-later
//
// computeLeaderboard ranks by the chain-authoritative `proofs_won` counter
// (`quantum_pow.Miners` storage via chainMiners) — the same number the
// rewards line and On-chain miners table show. The indexed /api/miner-wins
// dataset only supplies the per-miner quality metrics the chain doesn't
// store (avg mining time, best energy), which are null for miners whose
// wins haven't been decoded locally yet.

import { describe, expect, it } from "bun:test";

import type { ChainMinerRecord, MinerCategory, MinerWinsRow } from "@quip/shared/telemetry";

import { computeLeaderboard } from "./use-leaderboard";

const wins = (
  minerId: string,
  count: number,
  overrides: Partial<MinerWinsRow> = {},
): MinerWinsRow => ({
  minerId,
  wins: count,
  bestEnergy: -1,
  avgMiningTime: 10,
  lastWonAt: 1700000000,
  ...overrides,
});

const chainMiner = (
  accountId: string,
  proofsWon: string,
  primaryType?: MinerCategory,
): ChainMinerRecord => ({
  accountId,
  deposit: "0",
  proofsSubmitted: proofsWon,
  proofsWon,
  rewardsEarned: "0",
  telemetryNodeAddress: null,
  hardware: primaryType
    ? {
        accountId,
        nodeId: accountId,
        miners: [],
        primaryType,
        source: "self",
        observedAt: "2026-01-01T00:00:00Z",
      }
    : null,
});

describe("computeLeaderboard", () => {
  it("ranks by chain proofs_won descending and computes share of the total", () => {
    const miners = [chainMiner("5B", "3"), chainMiner("5A", "6"), chainMiner("5C", "1")];
    const out = computeLeaderboard(miners, []);
    expect(out.map((e) => [e.rank, e.minerId, e.blockCount])).toEqual([
      [1, "5A", 6],
      [2, "5B", 3],
      [3, "5C", 1],
    ]);
    expect(out[0]?.share).toBeCloseTo(0.6);
    expect(out[2]?.share).toBeCloseTo(0.1);
  });

  it("excludes registered miners with zero wins", () => {
    const out = computeLeaderboard([chainMiner("5A", "2"), chainMiner("5ZERO", "0")], []);
    expect(out.map((e) => e.minerId)).toEqual(["5A"]);
  });

  it("joins avg time and best energy from the indexed dataset; null when unindexed", () => {
    const miners = [chainMiner("5A", "6"), chainMiner("5B", "3")];
    const out = computeLeaderboard(miners, [
      wins("5A", 6, { bestEnergy: -3.25, avgMiningTime: 42 }),
    ]);
    const a = out.find((e) => e.minerId === "5A");
    const b = out.find((e) => e.minerId === "5B");
    expect(a?.bestEnergy).toBe(-3.25);
    expect(a?.avgMiningTime).toBe(42);
    // 5B's wins predate what the indexer decoded — metrics are unknown,
    // not zero.
    expect(b?.bestEnergy).toBeNull();
    expect(b?.avgMiningTime).toBeNull();
  });

  it("counts proofs_won even when the indexed dataset trails it", () => {
    // The user-visible bug this design fixes: chain says 30, indexer only
    // decoded 22 — the leaderboard must say 30, matching rewards.
    const out = computeLeaderboard([chainMiner("5A", "30")], [wins("5A", 22)]);
    expect(out[0]?.blockCount).toBe(30);
  });

  it("categorises via the chain-miner hardware index", () => {
    const miners = [chainMiner("5GPU", "5", "GPU"), chainMiner("5UNKNOWN", "2")];
    const out = computeLeaderboard(miners, []);
    expect(out.find((e) => e.minerId === "5GPU")?.minerCategory).toBe("GPU");
    expect(out.find((e) => e.minerId === "5UNKNOWN")?.minerCategory).toBe("OTHER");
  });

  it("filters by category and re-ranks/re-shares within the filtered set", () => {
    const miners = [
      chainMiner("5GPU", "6", "GPU"),
      chainMiner("5CPU", "3", "CPU"),
      chainMiner("5GPU2", "1", "GPU"),
    ];
    const out = computeLeaderboard(miners, [], { categories: new Set(["GPU"]) });
    expect(out.map((e) => [e.rank, e.minerId])).toEqual([
      [1, "5GPU"],
      [2, "5GPU2"],
    ]);
    // Share is of the GPU-only total (7), not the network total (10).
    expect(out[0]?.share).toBeCloseTo(6 / 7);
  });

  it("returns [] when no miner has won", () => {
    expect(computeLeaderboard([], [])).toEqual([]);
    expect(computeLeaderboard([chainMiner("5A", "0")], [wins("5A", 1)])).toEqual([]);
  });
});
