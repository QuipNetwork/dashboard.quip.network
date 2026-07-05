// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord, ChainMinerRecord, MinerHardwareRecord } from "@quip/shared/telemetry";
import { DIFFICULTY_DATA_FLOOR_ENERGY } from "@/lib/difficulty-curve";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";

import {
  useWinRateByDifficulty,
  type WinRateByDifficultyResult,
} from "./use-win-rate-by-difficulty";

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

function makeChainMiner(): ChainMinerRecord {
  const hardware: MinerHardwareRecord = {
    accountId: "5GCpu",
    nodeId: "node-1",
    miners: [{ id: "node-1-CPU-1", type: "CPU" }],
    primaryType: "CPU",
    source: "self",
    observedAt: "2026-05-26T00:00:00Z",
  };
  return {
    accountId: "5GCpu",
    deposit: "0",
    proofsSubmitted: "0",
    proofsWon: "0",
    rewardsEarned: "0",
    telemetryNodeAddress: null,
    hardware,
  };
}

function renderHook(): { current: WinRateByDifficultyResult } {
  const result = { current: { series: [], xMin: 0, xMax: 0 } as WinRateByDifficultyResult };
  function Probe(): null {
    result.current = useWinRateByDifficulty();
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

describe("useWinRateByDifficulty", () => {
  test("axis starts at the data floor — easy warmup targets are dropped", () => {
    const hard = [-14_560, -14_500, -14_400, -14_300, -14_200, -14_050];
    const warmup = [-100, -150, -200, -250, -300, -350];
    const blocks = [...hard, ...warmup].map((d, i) =>
      makeBlock({ blockHash: `0x${i}`, difficultyEnergy: d, energy: d }),
    );
    useTelemetryStore.setState({ blocks, chainMiners: [makeChainMiner()] });

    const { xMax } = renderHook().current;
    expect(xMax).toBeLessThanOrEqual(DIFFICULTY_DATA_FLOOR_ENERGY);
  });
});
