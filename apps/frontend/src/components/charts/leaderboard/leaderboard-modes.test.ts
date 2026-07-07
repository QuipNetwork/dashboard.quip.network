// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN } from "@/lib/device-access-time";
import { estimateCpuWatts, estimateEnergyJoules, QPU_SYSTEM_WATTS } from "@/lib/hardware-power";
import type {
  BlockRecord,
  ChainMinerRecord,
  MinerHardwareRecord,
  NodesSnapshot,
} from "@quip/shared/telemetry";

import {
  applyLeaderboardMode,
  computeMinerTimeEnergyTotals,
  formatEnergyJoules,
  withTimeEnergyTotals,
} from "./leaderboard-modes";
import { computeLeaderboard, type LeaderboardEntry } from "./use-leaderboard";

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    minerId: "5A",
    energy: -14_500,
    diversity: 0.5,
    numValidSolutions: 1,
    miningTime: 60,
    reward: "1000000000000",
    qblockId: "1",
    nonce: "1",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -14_500,
    minDiversity: 0.1,
    minSolutions: 1,
    topologyHash: null,
    finalized: true,
    deviceAccessTimeUs: null,
    ...overrides,
  };
}

function makeChainMiner(
  accountId: string,
  overrides: Partial<ChainMinerRecord> & { hardware?: MinerHardwareRecord | null } = {},
): ChainMinerRecord {
  return {
    accountId,
    deposit: "0",
    proofsSubmitted: "0",
    proofsWon: "0",
    rewardsEarned: "0",
    telemetryNodeAddress: null,
    hardware: null,
    ...overrides,
  };
}

function hardwareFor(
  accountId: string,
  nodeId: string,
  primaryType: "CPU" | "QPU",
): MinerHardwareRecord {
  return {
    accountId,
    nodeId,
    miners: [{ id: `${accountId}-1`, type: primaryType }],
    primaryType,
    source: "self",
    observedAt: "2026-01-01T00:00:00Z",
  };
}

describe("computeMinerTimeEnergyTotals", () => {
  test("sums exactly against the exported estimate/watt building blocks", () => {
    const cpuHardware = hardwareFor("5CPU", "node-cpu", "CPU");
    const cpuMiner = makeChainMiner("5CPU", {
      proofsWon: "2",
      telemetryNodeAddress: "node-cpu",
      hardware: cpuHardware,
    });
    const nodes: NodesSnapshot = {
      updatedAt: "2026-01-01T00:00:00Z",
      nodeCount: 1,
      activeCount: 1,
      nodes: {
        "node-cpu": {
          address: "node-cpu",
          status: "online",
          firstSeen: 0,
          lastSeen: 0,
          lastHeartbeat: null,
          systemInfo: { cpu: { brand: "AMD EPYC 7763", physicalCores: 64 } },
        },
      },
    };
    // Self-reported access times (µs) — no estimation on this path.
    const cpuBlocks = [
      makeBlock({ minerId: "5CPU", deviceAccessTimeUs: 2_000_000 }),
      makeBlock({ minerId: "5CPU", deviceAccessTimeUs: 3_000_000 }),
    ];

    const qpuMiner = makeChainMiner("5QPU", {
      proofsWon: "3",
      hardware: hardwareFor("5QPU", "5QPU", "QPU"),
    });
    // Unreported access time on every win, so all three fall to the
    // documented QPU estimate constant.
    const qpuBlocks = [
      makeBlock({ minerId: "5QPU", deviceAccessTimeUs: null }),
      makeBlock({ minerId: "5QPU", deviceAccessTimeUs: null }),
      makeBlock({ minerId: "5QPU", deviceAccessTimeUs: null }),
    ];

    const totals = computeMinerTimeEnergyTotals(
      [...cpuBlocks, ...qpuBlocks],
      [cpuMiner, qpuMiner],
      [],
      nodes,
    );

    const cpuWatts = estimateCpuWatts({ brand: "AMD EPYC 7763", physicalCores: 64 });
    const cpu = totals.get("5CPU");
    expect(cpu?.totalSeconds).toBeCloseTo(5); // 2s + 3s, self-reported
    expect(cpu?.totalJoules).toBeCloseTo(estimateEnergyJoules(cpuWatts, 5));
    expect(cpu?.estimated).toBe(false);

    const qpu = totals.get("5QPU");
    expect(qpu?.totalSeconds).toBeCloseTo(QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN * 3);
    expect(qpu?.totalJoules).toBeCloseTo(
      estimateEnergyJoules(QPU_SYSTEM_WATTS, QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN * 3),
    );
    expect(qpu?.estimated).toBe(true);
  });

  test("unknown hardware miner falls back to the category default watts, no NaN", () => {
    const unknownMiner = makeChainMiner("5UNKNOWN", { proofsWon: "1" });
    const blocks = [makeBlock({ minerId: "5UNKNOWN", miningTime: 42, deviceAccessTimeUs: null })];

    const totals = computeMinerTimeEnergyTotals(blocks, [unknownMiner], [], null);
    const entry = totals.get("5UNKNOWN");
    expect(entry?.totalSeconds).toBe(42);
    expect(entry?.totalJoules).toBeGreaterThan(0);
    expect(Number.isNaN(entry?.totalJoules)).toBe(false);
  });
});

describe("withTimeEnergyTotals", () => {
  function entry(id: string): LeaderboardEntry {
    return {
      rank: 1,
      minerId: id,
      minerCategory: "CPU",
      blockCount: 1,
      share: 1,
      avgMiningTime: null,
      bestEnergy: null,
    };
  }

  test("merges totals by minerId, defaulting untotalled miners to null/false", () => {
    const totals = new Map([["a", { totalSeconds: 5, totalJoules: 50, estimated: true }]]);
    const [a, b] = withTimeEnergyTotals([entry("a"), entry("b")], totals);
    expect(a).toMatchObject({ totalMiningSeconds: 5, totalEnergyJoules: 50, estimated: true });
    expect(b).toMatchObject({
      totalMiningSeconds: null,
      totalEnergyJoules: null,
      estimated: false,
    });
  });
});

describe("applyLeaderboardMode", () => {
  function entry(
    overrides: Partial<LeaderboardEntry> & Pick<LeaderboardEntry, "minerId">,
  ): LeaderboardEntry {
    return {
      rank: 1,
      minerCategory: "CPU",
      blockCount: 1,
      share: 1,
      avgMiningTime: null,
      bestEnergy: null,
      ...overrides,
    };
  }

  test("byCount passes entries through unchanged", () => {
    const entries = [entry({ minerId: "a", rank: 1 }), entry({ minerId: "b", rank: 2 })];
    expect(applyLeaderboardMode(entries, "byCount")).toEqual(entries);
  });

  test("byTime/byEnergy are lower-is-better and can invert a many-wins-CPU vs one-win-QPU byCount ranking", () => {
    // By Count: CPU wins 100 vs QPU's 1 — CPU ranks first.
    // But QPU's single win used far less device time/energy than CPU's 100
    // wins combined (real-world shape: ~0.06s/12kW QPU access vs CPU wall
    // time accumulated over many wins) — By Time/Energy must rank the
    // *smaller* total first (least energy/time = best = rank 1).
    const cpu = entry({
      minerId: "5CPU",
      rank: 1,
      blockCount: 100,
      totalMiningSeconds: 100,
      totalEnergyJoules: 4_000,
    });
    const qpu = entry({
      minerId: "5QPU",
      rank: 2,
      blockCount: 1,
      totalMiningSeconds: 0.062,
      totalEnergyJoules: 744,
    });
    const base = [cpu, qpu];

    const byTime = applyLeaderboardMode(base, "byTime");
    expect(byTime.map((e) => e.minerId)).toEqual(["5QPU", "5CPU"]);
    expect(byTime[0]?.rank).toBe(1);
    expect(byTime[0]?.share).toBeCloseTo(0.062 / 100.062);

    const byEnergy = applyLeaderboardMode(base, "byEnergy");
    expect(byEnergy.map((e) => e.minerId)).toEqual(["5QPU", "5CPU"]);
    expect(byEnergy[0]?.rank).toBe(1);
  });

  test("byCount stays higher-is-better (unaffected by the Energy/Time flip)", () => {
    const few = entry({ minerId: "few", blockCount: 3 });
    const many = entry({ minerId: "many", blockCount: 10 });
    const out = applyLeaderboardMode([few, many], "byCount");
    // byCount passes entries through unchanged (rank/share come from
    // computeLeaderboard's own descending wins sort) — it must NOT re-sort.
    expect(out).toEqual([few, many]);
  });

  test("missing totals contribute 0 to share, never NaN, and rank last (no data isn't 'best')", () => {
    const withTotals = entry({ minerId: "a", totalMiningSeconds: 10, totalEnergyJoules: 10 });
    const withoutTotals = entry({ minerId: "b" });
    const out = applyLeaderboardMode([withTotals, withoutTotals], "byTime");
    expect(out.map((e) => e.minerId)).toEqual(["a", "b"]);
    expect(out[1]?.share).toBe(0);
    expect(Number.isNaN(out[1]?.share)).toBe(false);
  });

  test("ascending order: smallest total ranks first for byTime and byEnergy", () => {
    const small = entry({ minerId: "small", totalMiningSeconds: 1, totalEnergyJoules: 5 });
    const medium = entry({ minerId: "medium", totalMiningSeconds: 5, totalEnergyJoules: 50 });
    const large = entry({ minerId: "large", totalMiningSeconds: 20, totalEnergyJoules: 500 });
    const base = [large, medium, small];

    const byTime = applyLeaderboardMode(base, "byTime");
    expect(byTime.map((e) => e.minerId)).toEqual(["small", "medium", "large"]);
    expect(byTime.map((e) => e.rank)).toEqual([1, 2, 3]);

    const byEnergy = applyLeaderboardMode(base, "byEnergy");
    expect(byEnergy.map((e) => e.minerId)).toEqual(["small", "medium", "large"]);
    expect(byEnergy.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  test("By Count values stay identical to pre-change computeLeaderboard output", () => {
    const miners = [
      makeChainMiner("5A", { proofsWon: "6" }),
      makeChainMiner("5B", { proofsWon: "3" }),
    ];
    const base = computeLeaderboard(miners, []);
    expect(applyLeaderboardMode(base, "byCount")).toEqual(base);
  });
});

describe("formatEnergyJoules", () => {
  test("scales J -> kJ -> kWh, never showing more than one unit", () => {
    expect(formatEnergyJoules(744)).toBe("744 J");
    expect(formatEnergyJoules(50_000)).toBe("50.00 kJ");
    expect(formatEnergyJoules(7_200_000)).toBe("2.00 kWh");
  });

  test("non-finite input renders the placeholder dash", () => {
    expect(formatEnergyJoules(NaN)).toBe("—");
  });
});
