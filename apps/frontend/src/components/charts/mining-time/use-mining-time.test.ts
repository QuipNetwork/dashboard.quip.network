// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Range-windowed mining-per-qblock series: the hook fetches
// /api/mining-history for the selected window and groups rows locally —
// "byType" into CPU/GPU/QPU lines (filtered by the global type selection),
// "all" into one aggregate line, "normalized" into the fixed-composition
// shares. The metric is the winner's device access time (seconds) or its
// estimated energy (joules). x is the on-chain qblock id.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  NORMALIZED_CPU_COUNT,
  NORMALIZED_GPU_COUNT,
  NORMALIZED_SERIES_IDS,
  NORMALIZED_SERIES_LABELS,
} from "@/components/charts/common/normalized-composition";
import { QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN } from "@/lib/device-access-time";
import { DEFAULT_CPU_WATTS_PER_CORE } from "@/lib/hardware-flops";
import { QPU_SYSTEM_WATTS } from "@/lib/hardware-power";
import { ServicesProvider } from "@/services/services-provider";
import type { TelemetryClient } from "@/services/telemetry-client";
import { idleTelemetryClient } from "@/testing/services";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import type {
  BlockRecord,
  ChainMinerRecord,
  MinerHardwareRecord,
  MiningHistoryRow,
  NodesSnapshot,
} from "@quip/shared/telemetry";

import {
  formatJoules,
  useMiningTime,
  type MiningMetric,
  type MiningTimeGrouping,
  type MiningTimeState,
} from "./use-mining-time";

// ---- Fixtures ----------------------------------------------------------

// 2026-07-02T12:00:00.000Z — fixed wall-clock for windowing assertions.
const NOW = Date.parse("2026-07-02T12:00:00.000Z");

const historyRow = (qblockId: number, minerId: string, miningTime: number): MiningHistoryRow => ({
  qblockId: String(qblockId),
  substrateBlockNumber: String(500_000 + qblockId),
  timestamp: 1_751_457_000 + qblockId,
  minerId,
  miningTime,
});

function makeHardware(overrides: Partial<MinerHardwareRecord> = {}): MinerHardwareRecord {
  return {
    accountId: "5GCpu",
    nodeId: "node-1",
    miners: [{ id: "node-1-CPU-1", type: "CPU" }],
    primaryType: "CPU",
    source: "self",
    observedAt: "2026-05-26T00:00:00Z",
    ...overrides,
  };
}

function makeChainMiner(overrides: Partial<ChainMinerRecord> = {}): ChainMinerRecord {
  return {
    accountId: "5GCpu",
    deposit: "0",
    proofsSubmitted: "0",
    proofsWon: "0",
    rewardsEarned: "0",
    telemetryNodeAddress: null,
    hardware: makeHardware(),
    ...overrides,
  };
}

const cpuMiner = makeChainMiner();
const gpuMiner = makeChainMiner({
  accountId: "5GGpu",
  hardware: makeHardware({
    accountId: "5GGpu",
    miners: [{ id: "node-2-GPU-1", type: "GPU" }],
    primaryType: "GPU",
  }),
});
const qpuMiner = makeChainMiner({
  accountId: "5GQpu",
  hardware: makeHardware({
    accountId: "5GQpu",
    miners: [{ id: "node-3-QPU-1", type: "QPU" }],
    primaryType: "QPU",
  }),
});

// A CPU winner joined to a telemetry node whose brand misses the FLOPS
// table, so its watt estimate is exactly DEFAULT_CPU_WATTS_PER_CORE × cores.
const CPU_NODE_CORES = 10;
const cpuMinerWithNode = makeChainMiner({ telemetryNodeAddress: "node-cpu" });
const cpuNodesSnapshot: NodesSnapshot = {
  updatedAt: "2026-07-02T11:59:00Z",
  nodeCount: 1,
  activeCount: 1,
  nodes: {
    "node-cpu": {
      address: "node-cpu",
      status: "active",
      firstSeen: NOW - 86_400_000,
      lastSeen: NOW,
      lastHeartbeat: NOW,
      systemInfo: { cpu: { brand: "Frobnicator 9000", physicalCores: CPU_NODE_CORES } },
    },
  },
};

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "500001",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_751_457_001,
    minerId: "5GCpu",
    energy: -14_500,
    diversity: 0.5,
    numValidSolutions: 1,
    miningTime: 10,
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

function makeClient(rows: MiningHistoryRow[]): { client: TelemetryClient; calls: string[] } {
  const calls: string[] = [];
  const client: TelemetryClient = {
    ...idleTelemetryClient,
    fetchMiningHistory: async (sinceIso: string) => {
      calls.push(sinceIso);
      return { since: sinceIso, rows };
    },
  };
  return { client, calls };
}

// ---- Harness -----------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useTelemetryStore.setState({
    blocks: [],
    nodes: null,
    chainMiners: [cpuMiner, gpuMiner],
    nodeDescriptors: [],
  });
  useUIStore.setState({ selectedTypes: ["CPU", "GPU", "QPU"] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useTelemetryStore.setState({ blocks: [], nodes: null, chainMiners: [], nodeDescriptors: [] });
});

function renderHook(
  client: TelemetryClient,
  range: "1h" | "24h",
  grouping: MiningTimeGrouping,
  metric: MiningMetric = "time",
): { current: MiningTimeState } {
  const result = { current: {} as MiningTimeState };
  function Probe(): null {
    result.current = useMiningTime(range, grouping, metric, { now: () => NOW });
    return null;
  }
  // Only the client is overridden — the stores fall back to the globals the
  // fixtures drive via setState (same pattern as ComputeAvailableView.test).
  act(() => {
    root.render(createElement(ServicesProvider, { client, children: createElement(Probe) }));
  });
  return result;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

// ---- Tests -------------------------------------------------------------

describe("useMiningTime", () => {
  test("fetches the selected window's cutoff", async () => {
    const { client, calls } = makeClient([]);
    renderHook(client, "1h", "byType");
    await settle();
    expect(calls).toEqual(["2026-07-02T11:00:00.000Z"]);
  });

  test("byType groups rows into type series with the qblock id on x", async () => {
    const { client } = makeClient([
      historyRow(1, "5GCpu", 10),
      historyRow(2, "5GGpu", 7),
      historyRow(3, "5GCpu", 20),
    ]);
    const result = renderHook(client, "24h", "byType");
    await settle();
    expect(result.current.loading).toBe(false);
    expect(result.current.series).toEqual([
      {
        id: "CPU",
        data: [
          { x: 1, y: 10 },
          { x: 3, y: 20 },
        ],
      },
      { id: "GPU", data: [{ x: 2, y: 7 }] },
    ]);
  });

  test("byType respects the global type selection", async () => {
    useUIStore.setState({ selectedTypes: ["GPU"] });
    const { client } = makeClient([historyRow(1, "5GCpu", 10), historyRow(2, "5GGpu", 7)]);
    const result = renderHook(client, "24h", "byType");
    await settle();
    expect(result.current.series).toEqual([{ id: "GPU", data: [{ x: 2, y: 7 }] }]);
  });

  test("all aggregates every win into a single series", async () => {
    const { client } = makeClient([
      historyRow(1, "5GCpu", 10),
      historyRow(2, "5GGpu", 7),
      historyRow(3, "5GCpu", 20),
    ]);
    const result = renderHook(client, "24h", "all");
    await settle();
    expect(result.current.series).toEqual([
      {
        id: "All",
        data: [
          { x: 1, y: 10 },
          { x: 2, y: 7 },
          { x: 3, y: 20 },
        ],
      },
    ]);
  });

  test("empty window → isEmpty", async () => {
    const { client } = makeClient([]);
    const result = renderHook(client, "1h", "all");
    await settle();
    expect(result.current.isEmpty).toBe(true);
    expect(result.current.series).toEqual([]);
  });

  // ---- Time vs Energy (winner-only metric, see module header) ------------

  test("QPU time uses the fixed access-time estimate, not miningTime", async () => {
    useTelemetryStore.setState({ chainMiners: [qpuMiner] });
    const { client } = makeClient([historyRow(1, "5GQpu", 42)]);
    const result = renderHook(client, "24h", "all", "time");
    await settle();
    expect(result.current.series).toEqual([
      { id: "All", data: [{ x: 1, y: QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN }] },
    ]);
  });

  test("energy = winner node's watt estimate × device seconds (CPU)", async () => {
    useTelemetryStore.setState({ chainMiners: [cpuMinerWithNode], nodes: cpuNodesSnapshot });
    const { client } = makeClient([historyRow(1, "5GCpu", 10)]);
    const result = renderHook(client, "24h", "all", "energy");
    await settle();
    // No table match for "Frobnicator 9000" → default watts/core × cores.
    const expected = DEFAULT_CPU_WATTS_PER_CORE * CPU_NODE_CORES * 10;
    expect(result.current.series).toEqual([{ id: "All", data: [{ x: 1, y: expected }] }]);
  });

  test("energy = QPU system watts × fixed access estimate (QPU, no node)", async () => {
    useTelemetryStore.setState({ chainMiners: [qpuMiner] });
    const { client } = makeClient([historyRow(1, "5GQpu", 42)]);
    const result = renderHook(client, "24h", "all", "energy");
    await settle();
    expect(result.current.series).toEqual([
      { id: "All", data: [{ x: 1, y: QPU_SYSTEM_WATTS * QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN }] },
    ]);
  });

  test("reported deviceAccessTimeUs in the recent-blocks window overrides miningTime", async () => {
    useTelemetryStore.setState({
      chainMiners: [cpuMiner, gpuMiner],
      blocks: [makeBlock({ qblockId: "1", deviceAccessTimeUs: 2_500_000 })],
    });
    const { client } = makeClient([historyRow(1, "5GCpu", 10)]);
    const result = renderHook(client, "24h", "all", "time");
    await settle();
    expect(result.current.series).toEqual([{ id: "All", data: [{ x: 1, y: 2.5 }] }]);
  });

  // ---- Normalized (canonical composition module) --------------------------

  test("normalized emits the canonical series ids and labels", async () => {
    const { client } = makeClient([historyRow(1, "5GCpu", 10), historyRow(2, "5GGpu", 7)]);
    const result = renderHook(client, "24h", "normalized");
    await settle();
    expect(result.current.series.map((s) => s.id)).toEqual([...NORMALIZED_SERIES_IDS]);
    expect(result.current.series.map((s) => s.label)).toEqual(
      NORMALIZED_SERIES_IDS.map((id) => NORMALIZED_SERIES_LABELS[id]),
    );
  });

  test("normalized shares follow the composition weights", async () => {
    // 24 alternating wins → bandSize 2, every band holds one CPU (10 s) and
    // one GPU (7 s) win. With one registered device per type the per-unit
    // averages are 10 and 7, so each band's shares come straight from the
    // module's composition counts.
    const rows: MiningHistoryRow[] = [];
    for (let i = 0; i < 24; i += 2) {
      rows.push(historyRow(i + 1, "5GCpu", 10));
      rows.push(historyRow(i + 2, "5GGpu", 7));
    }
    const { client } = makeClient(rows);
    const result = renderHook(client, "24h", "normalized");
    await settle();

    const cpuWeight = NORMALIZED_CPU_COUNT * 10;
    const gpuWeight = NORMALIZED_GPU_COUNT * 7;
    const expectedCpu = (100 * cpuWeight) / (cpuWeight + gpuWeight);
    const cpu = result.current.series.find((s) => s.id === "CPU")!;
    const gpu = result.current.series.find((s) => s.id === "GPU")!;
    expect(cpu.data).toHaveLength(12);
    for (const p of cpu.data) expect(p.y).toBeCloseTo(expectedCpu, 1);
    for (const p of gpu.data) expect(p.y).toBeCloseTo(100 - expectedCpu, 1);
  });

  test("normalized ignores the global type selection (fixed composition)", async () => {
    useUIStore.setState({ selectedTypes: ["GPU"] });
    const { client } = makeClient([historyRow(1, "5GCpu", 10), historyRow(2, "5GGpu", 7)]);
    const result = renderHook(client, "24h", "normalized");
    await settle();
    const cpu = result.current.series.find((s) => s.id === "CPU")!;
    expect(cpu.data.some((p) => p.y > 0)).toBe(true);
  });

  test("null deviceAccessTimeUs stays finite in every grouping/metric", async () => {
    useTelemetryStore.setState({ chainMiners: [cpuMiner, gpuMiner, qpuMiner] });
    const rows = [
      historyRow(1, "5GCpu", 10),
      historyRow(2, "5GGpu", 7),
      historyRow(3, "5GQpu", 42),
    ];
    for (const grouping of ["all", "byType", "normalized"] as const) {
      for (const metric of ["time", "energy"] as const) {
        const { client } = makeClient(rows);
        const result = renderHook(client, "24h", grouping, metric);
        await settle();
        expect(result.current.series.length).toBeGreaterThan(0);
        for (const s of result.current.series) {
          for (const p of s.data) expect(Number.isFinite(p.y)).toBe(true);
        }
      }
    }
  });
});

describe("formatJoules", () => {
  test("ladders J → kJ → MJ", () => {
    expect(formatJoules(999)).toBe("999.0 J");
    expect(formatJoules(1_500)).toBe("1.5 kJ");
    expect(formatJoules(2_500_000)).toBe("2.5 MJ");
  });
});
