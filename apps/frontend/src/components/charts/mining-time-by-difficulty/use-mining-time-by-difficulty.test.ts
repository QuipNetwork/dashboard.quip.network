// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-type cost curves: both scopes break out into CPU/GPU/QPU lines.
// "all" builds each type's curve from every winner of that type; "best"
// narrows each type to its single top winner first. Attempts/time math is
// unchanged (see mining-cost-model), applied per series.

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

// A spread of achieved energies in the hard regime, all from one miner.
// Distinct timestamps give each miner its own cadence.
function hardBlocks(minerId: string, stepSeconds = 120, count = 6): BlockRecord[] {
  const energies = [-14_100, -14_200, -14_300, -14_400, -14_500, -14_600];
  return energies.slice(0, count).map((e, i) =>
    makeBlock({
      blockHash: `0x${minerId}${i}`,
      minerId,
      energy: e,
      difficultyEnergy: -14_050,
      timestamp: 1_700_000_000 + i * stepSeconds,
    }),
  );
}

describe("useMiningTimeByDifficulty", () => {
  test("breaks out one series per processor type, ordered by the type selection", () => {
    useTelemetryStore.setState({
      blocks: [...hardBlocks("B", 60), ...hardBlocks("A", 120)],
      chainMiners: [makeChainMiner("A", "CPU"), makeChainMiner("B", "GPU")],
    });

    const { series } = renderHook({ units: "attempts", scope: "all" }).current;
    expect(series.map((s) => s.id)).toEqual(["CPU", "GPU"]);
  });

  test("attempts mode yields A(E) = 1/P per type, rising toward harder targets", () => {
    useTelemetryStore.setState({ blocks: hardBlocks("A"), chainMiners: [makeChainMiner("A")] });

    const { series, units } = renderHook({ units: "attempts", scope: "all" }).current;
    expect(units).toBe("attempts");
    expect(series).toHaveLength(1);
    expect(series[0]!.id).toBe("CPU");

    const data = series[0]!.data;
    // Easiest swept target met by all 6 -> 1 attempt; hardest met by 1 -> 6.
    const easiest = data.reduce((a, b) => (a.x > b.x ? a : b)); // max x (least negative)
    const hardest = data.reduce((a, b) => (a.x < b.x ? a : b)); // min x (most negative)
    expect(easiest.y).toBeCloseTo(1, 6);
    expect(hardest.y).toBeCloseTo(6, 6);
  });

  test("time mode scales each type by that type's own cadence", () => {
    useTelemetryStore.setState({
      blocks: [...hardBlocks("A", 120), ...hardBlocks("B", 60)],
      chainMiners: [makeChainMiner("A", "CPU"), makeChainMiner("B", "GPU")],
    });

    const attempts = renderHook({ units: "attempts", scope: "all" }).current.series;
    const timed = renderHook({ units: "time", scope: "all" }).current.series;
    const byId = (
      list: MiningTimeByDifficultyResult["series"],
      id: string,
    ): Array<{ x: number; y: number }> => list.find((s) => s.id === id)!.data;

    // CPU events are 120s apart, GPU 60s apart — each curve uses its own scale.
    for (const [id, scale] of [
      ["CPU", 120],
      ["GPU", 60],
    ] as const) {
      const a = byId(attempts, id);
      const t = byId(timed, id);
      for (let i = 0; i < t.length; i++) {
        expect(t[i]!.y).toBeCloseTo(a[i]!.y * scale, 4);
      }
    }
  });

  test("time mode labels the QPU line QPUWC (wall clock), attempts mode keeps QPU", () => {
    // The cadence-based time estimate for QPUs is wall clock (D-Wave cloud
    // round-trip + queue), not device time — the label must say so. A true
    // device-time "QPU" series joins once qpu_access_time_us data exists.
    useTelemetryStore.setState({
      blocks: hardBlocks("Q"),
      chainMiners: [makeChainMiner("Q", "QPU")],
    });

    const attempts = renderHook({ units: "attempts", scope: "all" }).current;
    const timed = renderHook({ units: "time", scope: "all" }).current;
    expect(attempts.series.map((s) => s.id)).toEqual(["QPU"]);
    expect(timed.series.map((s) => s.id)).toEqual(["QPUWC"]);
  });

  test("floor still drops easy warmup targets", () => {
    const warmup = [-100, -150, -200, -250, -300, -350].map((d, i) =>
      makeBlock({ blockHash: `0xw${i}`, minerId: "A", energy: d, difficultyEnergy: d }),
    );
    useTelemetryStore.setState({
      blocks: [...hardBlocks("A"), ...warmup],
      chainMiners: [makeChainMiner("A")],
    });

    const { xMax } = renderHook({ units: "attempts", scope: "all" }).current;
    expect(xMax).toBeLessThanOrEqual(DIFFICULTY_DATA_FLOOR_ENERGY);
  });

  test("best scope narrows each type to its top winner, keeping the type label", () => {
    // CPU: A wins 6, B wins 3 -> best CPU node is A.
    useTelemetryStore.setState({
      blocks: [...hardBlocks("A"), ...hardBlocks("B", 120, 3)],
      chainMiners: [makeChainMiner("A", "CPU"), makeChainMiner("B", "CPU")],
    });

    const all = renderHook({ units: "attempts", scope: "all" }).current;
    const best = renderHook({ units: "attempts", scope: "best" }).current;

    expect(all.series.map((s) => s.id)).toEqual(["CPU"]);
    expect(best.series.map((s) => s.id)).toEqual(["CPU"]);

    const hardestY = (r: MiningTimeByDifficultyResult): number =>
      r.series[0]!.data.reduce((a, b) => (a.x < b.x ? a : b)).y;
    // All-nodes CPU curve pools 9 observations (hardest target met by 1 of 9);
    // best-node narrows to A's 6.
    expect(hardestY(all)).toBeCloseTo(9, 6);
    expect(hardestY(best)).toBeCloseTo(6, 6);
  });

  test("honours the global type selection", () => {
    useUIStore.setState({ selectedTypes: ["GPU"] });
    useTelemetryStore.setState({
      blocks: [...hardBlocks("A"), ...hardBlocks("B", 60)],
      chainMiners: [makeChainMiner("A", "CPU"), makeChainMiner("B", "GPU")],
    });

    const { series } = renderHook({ units: "attempts", scope: "all" }).current;
    expect(series.map((s) => s.id)).toEqual(["GPU"]);
  });

  test("too few observations returns an explanatory note, no series", () => {
    useTelemetryStore.setState({
      blocks: hardBlocks("A").slice(0, 2),
      chainMiners: [makeChainMiner("A")],
    });

    const { series, note } = renderHook({ units: "attempts", scope: "all" }).current;
    expect(series).toHaveLength(0);
    expect(note).toBeTruthy();
  });
});
