// SPDX-License-Identifier: AGPL-3.0-or-later

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
  useWinRateByDifficulty,
  type WinRateByDifficultyOptions,
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

function makeChainMiner(accountId = "5GCpu", type: MinerCategory = "CPU"): ChainMinerRecord {
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

function renderHook(opts?: WinRateByDifficultyOptions): { current: WinRateByDifficultyResult } {
  const result = { current: { series: [], xMin: 0, xMax: 0 } as WinRateByDifficultyResult };
  function Probe(): null {
    result.current = useWinRateByDifficulty(opts);
    return null;
  }
  act(() => root.render(createElement(Probe)));
  return result;
}

// `count` hard-regime blocks for one miner, at evenly spaced difficulties
// starting from `startDifficulty` (10 units apart, most negative first).
function blocksFor(minerId: string, startDifficulty: number, count: number): BlockRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const d = startDifficulty + i * 10;
    return makeBlock({ blockHash: `0x${minerId}${i}`, minerId, difficultyEnergy: d, energy: d });
  });
}

function seriesById(result: WinRateByDifficultyResult, id: string) {
  const found = result.series.find((s) => s.id === id);
  if (!found) throw new Error(`missing series ${id}`);
  return found;
}

function ySum(result: WinRateByDifficultyResult, id: string): number {
  return seriesById(result, id).data.reduce((sum, p) => sum + p.y, 0);
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

  test("5a regression: every series spans the full [xMin, xMax] domain", () => {
    // Two types with disjoint difficulty ranges; 24 blocks -> 2-block bands,
    // so band midpoints differ from the raw min/max difficulties. The domain
    // must equal the span of plotted points, not the raw extremes.
    useTelemetryStore.setState({
      blocks: [...blocksFor("A", -14_600, 12), ...blocksFor("B", -14_480, 12)],
      chainMiners: [makeChainMiner("A", "CPU"), makeChainMiner("B", "GPU")],
    });

    const { series, xMin, xMax } = renderHook().current;
    expect(series.map((s) => s.id).sort()).toEqual(["CPU", "GPU"]);
    expect(xMin).toBeLessThan(xMax);
    for (const s of series) {
      expect(s.data.length).toBeGreaterThan(1);
      expect(s.data[0]!.x).toBe(xMin);
      expect(s.data[s.data.length - 1]!.x).toBe(xMax);
    }
  });

  test("best scope narrows each type to its single top winner", () => {
    // CPU: A wins 6, B wins 3 -> best CPU node is A. GPU: only G.
    useTelemetryStore.setState({
      blocks: [
        ...blocksFor("A", -14_600, 6),
        ...blocksFor("B", -14_540, 3),
        ...blocksFor("G", -14_510, 3),
      ],
      chainMiners: [
        makeChainMiner("A", "CPU"),
        makeChainMiner("B", "CPU"),
        makeChainMiner("G", "GPU"),
      ],
    });

    const all = renderHook({ mode: "all" }).current;
    const best = renderHook({ mode: "best" }).current;

    // 12 single-block bands for all-nodes; B's 3 wins drop out for best.
    expect(seriesById(all, "CPU").data).toHaveLength(12);
    expect(seriesById(best, "CPU").data).toHaveLength(9);
    // Sum of per-band win rates counts wins x100: 9 CPU wins vs A's 6.
    expect(ySum(all, "CPU")).toBeCloseTo(900, 6);
    expect(ySum(best, "CPU")).toBeCloseTo(600, 6);
    expect(ySum(best, "GPU")).toBeCloseTo(300, 6);
  });

  describe("normalized mode", () => {
    beforeEach(() => {
      useTelemetryStore.setState({
        blocks: [
          ...blocksFor("A", -14_600, 6),
          ...blocksFor("G", -14_540, 3),
          ...blocksFor("Q", -14_510, 3),
        ],
        chainMiners: [
          makeChainMiner("A", "CPU"),
          makeChainMiner("G", "GPU"),
          makeChainMiner("Q", "QPU"),
        ],
      });
    });

    test("emits the four composition series with display labels", () => {
      const { series } = renderHook({ mode: "normalized" }).current;
      expect(series.map((s) => s.id)).toEqual(["CPU", "GPU", "QPU20m", "QPU100"]);
      expect(series.map((s) => s.label)).toEqual(["CPU", "GPU", "QPU20m", "QPU100%"]);
    });

    test("win shares sum to ~100% in every difficulty band", () => {
      const result = renderHook({ mode: "normalized" }).current;
      const xs = seriesById(result, "CPU").data.map((p) => p.x);
      expect(xs.length).toBe(12);
      for (let i = 0; i < xs.length; i++) {
        const total = result.series.reduce((sum, s) => sum + s.data[i]!.y, 0);
        expect(Math.abs(total - 100)).toBeLessThan(0.5); // 0.1-rounding slack
      }
    });

    test("QPU100% beats QPU20m wherever the QPU won (participation scaling)", () => {
      const result = renderHook({ mode: "normalized" }).current;
      const q20 = seriesById(result, "QPU20m").data;
      const q100 = seriesById(result, "QPU100").data;
      const active = q20.map((p, i) => [p.y, q100[i]!.y]).filter(([y20]) => y20! > 0);
      expect(active.length).toBeGreaterThan(0);
      for (const [y20, y100] of active) {
        expect(y100!).toBeGreaterThan(y20!);
      }
    });

    test("ignores the per-type chips — the composition is fixed", () => {
      useUIStore.setState({ selectedTypes: ["GPU"] });
      const result = renderHook({ mode: "normalized" }).current;
      expect(result.series.map((s) => s.id)).toEqual(["CPU", "GPU", "QPU20m", "QPU100"]);
      expect(ySum(result, "CPU")).toBeGreaterThan(0);
      // Contrast: the observed modes do honour the chips.
      const all = renderHook({ mode: "all" }).current;
      expect(all.series.map((s) => s.id)).toEqual(["GPU"]);
    });
  });
});
