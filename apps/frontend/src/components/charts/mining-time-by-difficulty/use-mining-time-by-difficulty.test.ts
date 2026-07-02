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
  useMiningTimeByDifficulty,
  type MiningCostOptions,
  type MiningTimeByDifficultyResult,
} from "./use-mining-time-by-difficulty";

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
    ...overrides,
  };
}

function makeChainMiner(accountId: string): ChainMinerRecord {
  const hardware: MinerHardwareRecord = {
    accountId,
    nodeId: `node-${accountId}`,
    miners: [{ id: `${accountId}-CPU-1`, type: "CPU" }],
    primaryType: "CPU",
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

function renderHook(opts: MiningCostOptions): { current: MiningTimeByDifficultyResult } {
  const result = {
    current: {
      series: [],
      xMin: 0,
      xMax: 0,
      units: "attempts",
      note: null,
    } as MiningTimeByDifficultyResult,
  };
  function Probe(): null {
    result.current = useMiningTimeByDifficulty(opts);
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

// A spread of achieved energies in the hard regime, all from one CPU miner so
// they survive the selectedTypes filter. Distinct timestamps give a cadence.
function hardBlocks(minerId = "A"): BlockRecord[] {
  const energies = [-14_100, -14_200, -14_300, -14_400, -14_500, -14_600];
  return energies.map((e, i) =>
    makeBlock({
      blockHash: `0x${minerId}${i}`,
      minerId,
      energy: e,
      difficultyEnergy: -14_050,
      timestamp: 1_700_000_000 + i * 120, // 120s apart
    }),
  );
}

describe("useMiningTimeByDifficulty", () => {
  test("attempts mode yields A(E) = 1/P, rising toward harder targets", () => {
    useTelemetryStore.setState({ blocks: hardBlocks(), chainMiners: [makeChainMiner("A")] });

    const { series, units } = renderHook({ units: "attempts", scope: "all" }).current;
    expect(units).toBe("attempts");
    expect(series).toHaveLength(1);

    const data = series[0]!.data;
    // Easiest swept target met by all 6 -> 1 attempt; hardest met by 1 -> 6.
    const easiest = data.reduce((a, b) => (a.x > b.x ? a : b)); // max x (least negative)
    const hardest = data.reduce((a, b) => (a.x < b.x ? a : b)); // min x (most negative)
    expect(easiest.y).toBeCloseTo(1, 6);
    expect(hardest.y).toBeCloseTo(6, 6);
  });

  test("time mode scales attempts by the median inter-event interval", () => {
    useTelemetryStore.setState({ blocks: hardBlocks(), chainMiners: [makeChainMiner("A")] });

    const attempts = renderHook({ units: "attempts", scope: "all" }).current.series[0]!.data;
    const timed = renderHook({ units: "time", scope: "all" }).current.series[0]!.data;

    // Timestamps are 120s apart, so the median interval is 120s; every point
    // should be the attempts value times 120.
    for (let i = 0; i < timed.length; i++) {
      expect(timed[i]!.y).toBeCloseTo(attempts[i]!.y * 120, 4);
    }
  });

  test("floor still drops easy warmup targets", () => {
    const warmup = [-100, -150, -200, -250, -300, -350].map((d, i) =>
      makeBlock({ blockHash: `0xw${i}`, minerId: "A", energy: d, difficultyEnergy: d }),
    );
    useTelemetryStore.setState({
      blocks: [...hardBlocks(), ...warmup],
      chainMiners: [makeChainMiner("A")],
    });

    const { xMax } = renderHook({ units: "attempts", scope: "all" }).current;
    expect(xMax).toBeLessThanOrEqual(DIFFICULTY_DATA_FLOOR_ENERGY);
  });

  test("best-node scope narrows to the top winner and labels the series", () => {
    // B wins 6, A wins 3 -> best node is B.
    useTelemetryStore.setState({
      blocks: [...hardBlocks("B"), ...hardBlocks("A").slice(0, 3)],
      chainMiners: [makeChainMiner("A"), makeChainMiner("B")],
    });

    const all = renderHook({ units: "attempts", scope: "all" }).current;
    const best = renderHook({ units: "attempts", scope: "best" }).current;

    expect(all.series[0]!.id).toBe("All Nodes");
    // Best node B published no rig name, so the label falls back to a short SS58.
    expect(best.series[0]!.id).not.toBe("All Nodes");
    expect(best.series[0]!.id).toContain("B");
  });

  test("too few observations returns an explanatory note, no series", () => {
    useTelemetryStore.setState({
      blocks: hardBlocks().slice(0, 2),
      chainMiners: [makeChainMiner("A")],
    });

    const { series, note } = renderHook({ units: "attempts", scope: "all" }).current;
    expect(series).toHaveLength(0);
    expect(note).toBeTruthy();
  });
});
