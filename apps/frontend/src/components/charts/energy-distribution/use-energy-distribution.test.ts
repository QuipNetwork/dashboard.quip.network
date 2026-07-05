// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Covers useEnergyDistributionByType (WU10). The pre-existing
// useEnergyDistribution (stacked, hard-regime-clipped) is unchanged and out
// of scope here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  BlockRecord,
  ChainMinerRecord,
  MinerCategory,
  MinerHardwareRecord,
} from "@quip/shared/telemetry";
import { useTelemetryStore } from "@/store/telemetry-store";

import {
  useEnergyDistributionByType,
  type EnergyDistributionByTypeOptions,
  type EnergyDistributionByTypeResult,
} from "./use-energy-distribution";

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    minerId: "5GCpu",
    energy: -15_600,
    diversity: 0.5,
    numValidSolutions: 1,
    miningTime: 60,
    reward: "1000000000000",
    qblockId: "1",
    nonce: "1",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -15_500,
    minDiversity: 0.1,
    minSolutions: 1,
    topologyHash: null,
    finalized: true,
    deviceAccessTimeUs: null,
    ...overrides,
  };
}

function makeChainMiner(accountId: string, type: MinerCategory): ChainMinerRecord {
  const hardware: MinerHardwareRecord = {
    accountId,
    nodeId: `node-${accountId}`,
    miners: [{ id: `${accountId}-${type}-1`, type }],
    primaryType: type,
    source: "self",
    observedAt: "2026-05-26T00:00:00Z",
  };
  return {
    accountId,
    deposit: "0",
    proofsSubmitted: "0",
    proofsWon: "0",
    rewardsEarned: "0",
    telemetryNodeAddress: null,
    hardware,
  };
}

function renderHook(opts: EnergyDistributionByTypeOptions = {}): {
  current: EnergyDistributionByTypeResult;
} {
  const result = { current: { types: [] } as EnergyDistributionByTypeResult };
  function Probe(): null {
    result.current = useEnergyDistributionByType(opts);
    return null;
  }
  act(() => root.render(createElement(Probe)));
  return result;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useTelemetryStore.setState({ blocks: [], chainMiners: [], nodeDescriptors: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// Blocks descend by substrate_block_number, matching the store's real
// ordering (tip = index 0), so blocks[0].topologyHash resolves the "current
// topology" filter the same way the hook does.
function tipFirst(blocks: BlockRecord[]): BlockRecord[] {
  return [...blocks].sort(
    (a, b) => Number(b.substrateBlockNumber) - Number(a.substrateBlockNumber),
  );
}

describe("useEnergyDistributionByType", () => {
  test("always returns exactly CPU, GPU, QPU in that order", () => {
    const { types } = renderHook().current;
    expect(types.map((t) => t.type)).toEqual(["CPU", "GPU", "QPU"]);
  });

  test("a type with zero wins comes back as an explicit empty state, not a crash", () => {
    useTelemetryStore.setState({
      blocks: [makeBlock({ minerId: "A", substrateBlockNumber: "100" })],
      chainMiners: [makeChainMiner("A", "CPU")],
    });

    const { types } = renderHook().current;
    const gpu = types.find((t) => t.type === "GPU")!;
    expect(gpu.totalWins).toBe(0);
    expect(gpu.percentages.every((p) => p === 0)).toBe(true);
  });

  test("each type's own percentages sum to ~100, independent of the other types", () => {
    const blocks = tipFirst([
      makeBlock({ blockHash: "0xa1", substrateBlockNumber: "103", minerId: "A", energy: -15_620 }),
      makeBlock({ blockHash: "0xa2", substrateBlockNumber: "102", minerId: "A", energy: -15_600 }),
      makeBlock({ blockHash: "0xa3", substrateBlockNumber: "101", minerId: "A", energy: -15_580 }),
      makeBlock({ blockHash: "0xb1", substrateBlockNumber: "100", minerId: "B", energy: -15_610 }),
    ]);
    useTelemetryStore.setState({
      blocks,
      chainMiners: [makeChainMiner("A", "CPU"), makeChainMiner("B", "GPU")],
    });

    const { types } = renderHook().current;
    const cpu = types.find((t) => t.type === "CPU")!;
    const gpu = types.find((t) => t.type === "GPU")!;
    expect(cpu.totalWins).toBe(3);
    expect(gpu.totalWins).toBe(1);
    expect(cpu.percentages.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
    expect(gpu.percentages.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
  });

  test("the anchor bucket contains the hardest current-topology win, shared across all three types", () => {
    const blocks = tipFirst([
      makeBlock({ blockHash: "0xa1", substrateBlockNumber: "102", minerId: "A", energy: -15_620 }),
      makeBlock({ blockHash: "0xb1", substrateBlockNumber: "101", minerId: "B", energy: -15_400 }),
    ]);
    useTelemetryStore.setState({
      blocks,
      chainMiners: [makeChainMiner("A", "CPU"), makeChainMiner("B", "GPU")],
    });

    const { types } = renderHook().current;
    const cpu = types.find((t) => t.type === "CPU")!;
    const gpu = types.find((t) => t.type === "GPU")!;
    // Same shared bucket grid (anchored at -15620) for every type.
    expect(cpu.buckets[0]).toEqual(gpu.buckets[0]);
    expect(cpu.buckets[0]!.label).toBe("< -15600");
    // CPU's win sits at the anchor -> all its weight lands in bucket 0.
    expect(cpu.percentages[0]).toBeCloseTo(100, 0);
  });

  test("other-topology blocks are excluded from the anchor computation", () => {
    const blocks = tipFirst([
      // Tip is on "topo-b"; its winner is much easier than the stale
      // "topo-a" history, which must not drag the anchor harder.
      makeBlock({
        blockHash: "0xtip",
        substrateBlockNumber: "200",
        minerId: "A",
        energy: -15_000,
        topologyHash: "topo-b",
      }),
      makeBlock({
        blockHash: "0xstale",
        substrateBlockNumber: "100",
        minerId: "A",
        energy: -99_000,
        topologyHash: "topo-a",
      }),
    ]);
    useTelemetryStore.setState({ blocks, chainMiners: [makeChainMiner("A", "CPU")] });

    const { types } = renderHook().current;
    const cpu = types.find((t) => t.type === "CPU")!;
    expect(cpu.totalWins).toBe(1);
    expect(cpu.buckets[0]!.label).toBe("< -14980");
  });

  test("'best' scope narrows each type to its top winner", () => {
    // CPU: A wins 2, B wins 1 -> best CPU node is A.
    const blocks = tipFirst([
      makeBlock({ blockHash: "0xa1", substrateBlockNumber: "103", minerId: "A", energy: -15_620 }),
      makeBlock({ blockHash: "0xa2", substrateBlockNumber: "102", minerId: "A", energy: -15_600 }),
      makeBlock({ blockHash: "0xb1", substrateBlockNumber: "101", minerId: "B", energy: -15_400 }),
    ]);
    useTelemetryStore.setState({
      blocks,
      chainMiners: [makeChainMiner("A", "CPU"), makeChainMiner("B", "CPU")],
    });

    const all = renderHook({ scope: "all" }).current;
    const best = renderHook({ scope: "best" }).current;
    expect(all.types.find((t) => t.type === "CPU")!.totalWins).toBe(3);
    expect(best.types.find((t) => t.type === "CPU")!.totalWins).toBe(2);
  });

  test("empty chain (no blocks) renders all three types as empty states", () => {
    const { types } = renderHook().current;
    expect(types).toHaveLength(3);
    expect(types.every((t) => t.totalWins === 0)).toBe(true);
  });
});
