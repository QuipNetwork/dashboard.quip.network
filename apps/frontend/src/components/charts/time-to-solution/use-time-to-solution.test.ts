// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bucket boundaries (nextsteps.md #4b), 85th-percentile domain cap (#4a),
// and the "Best Nodes" scope (#4c) — mirrors mining-time-by-difficulty's
// hook test conventions (makeBlock/makeChainMiner, direct store setState).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord, ChainMinerRecord, MinerCategory } from "@quip/shared/telemetry";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";

import { useTimeToSolution, type TimeToSolutionOptions } from "./use-time-to-solution";
import type { HistogramData } from "@/lib/histogram";

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
  return {
    accountId,
    deposit: "0",
    proofsSubmitted: "0",
    proofsWon: "0",
    rewardsEarned: "0",
    telemetryNodeAddress: null,
    hardware: {
      accountId,
      nodeId: `node-${accountId}`,
      miners: [{ id: `${accountId}-${type}-1`, type }],
      primaryType: type,
      source: "self",
      observedAt: "2026-05-26T00:00:00Z",
    },
  };
}

function renderHook(opts: TimeToSolutionOptions = {}): { current: HistogramData } {
  const result = { current: { data: [], keys: [] } as HistogramData };
  function Probe(): null {
    result.current = useTimeToSolution(opts);
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

describe("useTimeToSolution bucketing", () => {
  test("100 falls in the 0-100 bucket, 101 in the 101-200 bucket", () => {
    useTelemetryStore.setState({
      blocks: [
        makeBlock({ blockHash: "0xa", minerId: "A", miningTime: 100 }),
        makeBlock({ blockHash: "0xb", minerId: "A", miningTime: 101 }),
      ],
      chainMiners: [makeChainMiner("A", "CPU")],
    });

    const { data } = renderHook().current;
    const bins = data.map((row) => row.bin);
    expect(bins).toContain("0-100");
    expect(bins).toContain("101-200");

    const zeroHundred = data.find((row) => row.bin === "0-100")!;
    const oneOhOne = data.find((row) => row.bin === "101-200")!;
    expect(zeroHundred.CPU).toBe(1);
    expect(oneOhOne.CPU).toBe(1);
  });
});

describe("useTimeToSolution 85th-percentile range cap", () => {
  test("caps the domain at the pct bucket, folding outliers into a > Ns bucket", () => {
    // 17 regular wins spread 100..1700s, plus 3 outliers at 10,000s (n=20).
    // Nearest-rank 85th pct (ceil(0.85*20)=17th smallest) lands on the
    // largest regular value (1700s), so the domain should stop at its
    // bucket (1601-1700) and fold all 3 outliers into "> 1700s".
    const regular = Array.from({ length: 17 }, (_, i) =>
      makeBlock({ blockHash: `0xr${i}`, minerId: "A", miningTime: (i + 1) * 100 }),
    );
    const outliers = Array.from({ length: 3 }, (_, i) =>
      makeBlock({ blockHash: `0xo${i}`, minerId: "A", miningTime: 10_000 }),
    );
    useTelemetryStore.setState({
      blocks: [...regular, ...outliers],
      chainMiners: [makeChainMiner("A", "CPU")],
    });

    const { data } = renderHook().current;
    const last = data[data.length - 1]!;
    expect(last.bin).toBe("> 1700s");
    expect(last.CPU).toBe(3);

    // No regular bucket beyond the pct cap.
    expect(data.some((row) => row.bin === "1701-1800")).toBe(false);
    // Domain still covers the full regular range up to the cap.
    expect(data.some((row) => row.bin === "1601-1700")).toBe(true);
  });

  test("no overflow bucket when nothing exceeds the pct cap", () => {
    const blocks = Array.from({ length: 5 }, (_, i) =>
      makeBlock({ blockHash: `0x${i}`, minerId: "A", miningTime: 100 + i }),
    );
    useTelemetryStore.setState({ blocks, chainMiners: [makeChainMiner("A", "CPU")] });

    const { data } = renderHook().current;
    expect(data.every((row) => !String(row.bin).startsWith(">"))).toBe(true);
  });
});

describe("useTimeToSolution node scope", () => {
  test("best narrows each category to its single top winner", () => {
    useUIStore.setState({ aggregationMode: "byNode" });
    useTelemetryStore.setState({
      blocks: [
        ...Array.from({ length: 5 }, (_, i) =>
          makeBlock({ blockHash: `0xa${i}`, minerId: "A", miningTime: 100 }),
        ),
        ...Array.from({ length: 2 }, (_, i) =>
          makeBlock({ blockHash: `0xb${i}`, minerId: "B", miningTime: 100 }),
        ),
      ],
      chainMiners: [makeChainMiner("A", "CPU"), makeChainMiner("B", "CPU")],
    });

    const all = renderHook({ scope: "all" }).current;
    const best = renderHook({ scope: "best" }).current;

    expect(all.keys.sort()).toEqual(["A", "B"]);
    expect(best.keys).toEqual(["A"]);
  });

  test("defaults to all nodes when scope is omitted (backward-compatible call)", () => {
    useTelemetryStore.setState({
      blocks: [makeBlock({ blockHash: "0xa", minerId: "A", miningTime: 100 })],
      chainMiners: [makeChainMiner("A", "CPU")],
    });

    const { data } = renderHook().current;
    expect(data.length).toBeGreaterThan(0);
  });
});
