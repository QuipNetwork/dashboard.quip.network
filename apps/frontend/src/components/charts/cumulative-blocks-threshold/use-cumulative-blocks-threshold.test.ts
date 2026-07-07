// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scope toggle: "all" pools every winner; "best" narrows the blocks to each
// processor type's single top winner before the threshold sweep, so the axis
// and curves reflect only what the best nodes achieved.

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
import { useUIStore } from "@/store/ui-store";

import {
  useCumulativeBlocksThreshold,
  type CumulativeBlocksThresholdResult,
  type ThresholdOptions,
} from "./use-cumulative-blocks-threshold";

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    minerId: "5GCpu",
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
    finalized: false,
    deviceAccessTimeUs: null,
    ...overrides,
  };
}

function makeChainMiner(accountId: string, type: MinerCategory = "CPU"): ChainMinerRecord {
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

function blocksFor(minerId: string, energies: number[]): BlockRecord[] {
  return energies.map((e, i) => makeBlock({ blockHash: `0x${minerId}${i}`, minerId, energy: e }));
}

function renderHook(opts: ThresholdOptions): { current: CumulativeBlocksThresholdResult } {
  const result = {
    current: { series: [], xMin: 0, xMax: 0 } as CumulativeBlocksThresholdResult,
  };
  function Probe(): null {
    result.current = useCumulativeBlocksThreshold(opts);
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
  useUIStore.setState({ aggregationMode: "byType", selectedTypes: ["CPU", "GPU", "QPU"] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// A wins 4 deep blocks, B wins 2 shallow ones — best CPU node is A, and the
// two ranges are disjoint so the swept axis tells the scopes apart.
const A_ENERGIES = [-14_600, -14_575, -14_550, -14_525];
const B_ENERGIES = [-14_100, -14_050];

describe("useCumulativeBlocksThreshold", () => {
  test("best scope narrows each type to its top winner, keeping the type label", () => {
    useTelemetryStore.setState({
      blocks: [...blocksFor("A", A_ENERGIES), ...blocksFor("B", B_ENERGIES)],
      chainMiners: [makeChainMiner("A", "CPU"), makeChainMiner("B", "CPU")],
    });

    const all = renderHook({ scope: "all" }).current;
    const best = renderHook({ scope: "best" }).current;

    expect(all.series.map((s) => s.id)).toEqual(["CPU"]);
    expect(best.series.map((s) => s.id)).toEqual(["CPU"]);

    // All-nodes axis spans B's shallow wins too; best-node stops at A's.
    expect(all.xMax).toBe(-14_050);
    expect(best.xMax).toBe(-14_525);
  });

  test("best scope in per-miner mode keeps only each type's top winner", () => {
    useUIStore.setState({ aggregationMode: "byNode" });
    useTelemetryStore.setState({
      blocks: [
        ...blocksFor("A", A_ENERGIES),
        ...blocksFor("B", B_ENERGIES),
        ...blocksFor("G", [-14_300, -14_200]),
      ],
      chainMiners: [
        makeChainMiner("A", "CPU"),
        makeChainMiner("B", "CPU"),
        makeChainMiner("G", "GPU"),
      ],
    });

    const best = renderHook({ scope: "best" }).current;
    expect(best.series.map((s) => s.id).sort()).toEqual(["A", "G"]);
  });
});
