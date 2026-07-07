// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Range-windowed mining-per-qblock series: the hook fetches
// /api/mining-history for the selected window (which bounds the in-range
// qblocks and orders the x-axis) and joins each qblock to its participant
// totals from store.participationCompute — "byType" into CPU/GPU/QPU lines
// (filtered by the global type selection), "all" into one aggregate line,
// "normalized" into the fixed-composition shares. The metric is the TOTAL
// participant device access time (seconds) or its estimated energy (joules).

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
import { estimateDeviceWatts, estimateEnergyJoules } from "@/lib/hardware-power";
import { ServicesProvider } from "@/services/services-provider";
import type { TelemetryClient } from "@/services/telemetry-client";
import { idleTelemetryClient } from "@/testing/services";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import {
  QPU_ACCESS_TO_WALL_RATIO,
  type ChainMinerRecord,
  type MinerHardwareRecord,
  type MiningHistoryRow,
  type ParticipationComputeRow,
} from "@quip/shared/telemetry";

import {
  useMiningTime,
  type MiningMetric,
  type MiningTimeGrouping,
  type MiningTimeState,
} from "./use-mining-time";

// ---- Fixtures ----------------------------------------------------------

// 2026-07-02T12:00:00.000Z — fixed wall-clock for windowing assertions.
const NOW = Date.parse("2026-07-02T12:00:00.000Z");

// Winner rows only bound the range + order the x-axis now; miningTime is unused
// for the y-value (that comes from participation), so any value is fine.
const historyRow = (qblockId: number, minerId = "5GCpu"): MiningHistoryRow => ({
  qblockId: String(qblockId),
  substrateBlockNumber: String(500_000 + qblockId),
  timestamp: 1_751_457_000 + qblockId,
  minerId,
  miningTime: 0,
});

const part = (
  qblockId: number,
  account: string,
  kind: string,
  miningSeconds: number,
  exactQpuAccessUs: number | null = null,
): ParticipationComputeRow => ({
  qblockId: String(qblockId),
  account,
  kind,
  miningSeconds,
  exactQpuAccessUs,
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

// One registered device per type — the normalized census denominator.
const cpuMiner = makeChainMiner();
const gpuMiner = makeChainMiner({
  accountId: "5GGpu",
  hardware: makeHardware({
    accountId: "5GGpu",
    miners: [{ id: "node-2-GPU-1", type: "GPU" }],
    primaryType: "GPU",
  }),
});

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
    participationCompute: [],
    chainMiners: [cpuMiner, gpuMiner],
    nodeDescriptors: [],
  });
  useUIStore.setState({ selectedTypes: ["CPU", "GPU", "QPU"] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useTelemetryStore.setState({ participationCompute: [], chainMiners: [], nodeDescriptors: [] });
});

function setParticipation(rows: ParticipationComputeRow[]): void {
  useTelemetryStore.setState({ participationCompute: rows });
}

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

  test("byType sums participant device time per type per qblock (not winner-only)", async () => {
    setParticipation([
      part(1, "A", "Cpu", 10),
      part(1, "B", "Cpu", 5), // co-racer on the same qblock — both count
      part(2, "G", "Gpu", 7),
      part(3, "A", "Cpu", 20),
    ]);
    const { client } = makeClient([historyRow(1), historyRow(2), historyRow(3)]);
    const result = renderHook(client, "24h", "byType");
    await settle();
    expect(result.current.loading).toBe(false);
    expect(result.current.series).toEqual([
      {
        id: "CPU",
        data: [
          { x: 1, y: 15 },
          { x: 3, y: 20 },
        ],
      },
      { id: "GPU", data: [{ x: 2, y: 7 }] },
    ]);
  });

  test("byType respects the global type selection", async () => {
    useUIStore.setState({ selectedTypes: ["GPU"] });
    setParticipation([part(1, "A", "Cpu", 10), part(2, "G", "Gpu", 7)]);
    const { client } = makeClient([historyRow(1), historyRow(2)]);
    const result = renderHook(client, "24h", "byType");
    await settle();
    expect(result.current.series).toEqual([{ id: "GPU", data: [{ x: 2, y: 7 }] }]);
  });

  test("all aggregates every type into a single per-qblock sum", async () => {
    setParticipation([
      part(1, "A", "Cpu", 10),
      part(1, "G", "Gpu", 3), // same qblock, different type — summed
      part(2, "G", "Gpu", 7),
      part(3, "A", "Cpu", 20),
    ]);
    const { client } = makeClient([historyRow(1), historyRow(2), historyRow(3)]);
    const result = renderHook(client, "24h", "all");
    await settle();
    expect(result.current.series).toEqual([
      {
        id: "All",
        data: [
          { x: 1, y: 13 },
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

  test("qblocks in range but without participation contribute no point", async () => {
    setParticipation([part(2, "G", "Gpu", 7)]);
    const { client } = makeClient([historyRow(1), historyRow(2), historyRow(3)]);
    const result = renderHook(client, "24h", "all");
    await settle();
    expect(result.current.series).toEqual([{ id: "All", data: [{ x: 2, y: 7 }] }]);
  });

  // ---- Time vs Energy ----------------------------------------------------

  test("QPU device time uses the exact self-reported access when present", async () => {
    setParticipation([part(1, "Q", "Qpu", 999, 42_000_000)]); // 42s exact, not 999 wall
    const { client } = makeClient([historyRow(1, "5GQpu")]);
    const result = renderHook(client, "24h", "all", "time");
    await settle();
    expect(result.current.series).toEqual([{ id: "All", data: [{ x: 1, y: 42 }] }]);
  });

  test("QPU device time falls back to the wall/ratio estimate", async () => {
    setParticipation([part(1, "Q", "Qpu", QPU_ACCESS_TO_WALL_RATIO * 2)]);
    const { client } = makeClient([historyRow(1, "5GQpu")]);
    const result = renderHook(client, "24h", "all", "time");
    await settle();
    const point = result.current.series[0]!.data[0]!;
    expect(point.x).toBe(1);
    expect(point.y).toBeCloseTo(2, 6);
  });

  test("energy = category default watts × device seconds (CPU)", async () => {
    setParticipation([part(1, "A", "Cpu", 10)]);
    const { client } = makeClient([historyRow(1)]);
    const result = renderHook(client, "24h", "all", "energy");
    await settle();
    const expected = estimateEnergyJoules(estimateDeviceWatts("CPU", null), 10);
    expect(result.current.series).toEqual([{ id: "All", data: [{ x: 1, y: expected }] }]);
  });

  test("energy = QPU system watts × exact access seconds", async () => {
    setParticipation([part(1, "Q", "Qpu", 999, 42_000_000)]);
    const { client } = makeClient([historyRow(1, "5GQpu")]);
    const result = renderHook(client, "24h", "all", "energy");
    await settle();
    const expected = estimateEnergyJoules(estimateDeviceWatts("QPU", null), 42);
    expect(result.current.series).toEqual([{ id: "All", data: [{ x: 1, y: expected }] }]);
  });

  // ---- Normalized (canonical composition module) --------------------------

  test("normalized emits the canonical series ids and labels", async () => {
    setParticipation([part(1, "A", "Cpu", 10), part(2, "G", "Gpu", 7)]);
    const { client } = makeClient([historyRow(1), historyRow(2)]);
    const result = renderHook(client, "24h", "normalized");
    await settle();
    expect(result.current.series.map((s) => s.id)).toEqual([...NORMALIZED_SERIES_IDS]);
    expect(result.current.series.map((s) => s.label)).toEqual(
      NORMALIZED_SERIES_IDS.map((id) => NORMALIZED_SERIES_LABELS[id]),
    );
  });

  test("normalized shares follow the composition weights", async () => {
    // 24 alternating qblocks → bandSize 2, every band holds one CPU (10 s) and
    // one GPU (7 s) qblock. With one registered device per type the per-unit
    // averages are 10 and 7, so each band's shares come straight from the
    // module's composition counts.
    const rows: MiningHistoryRow[] = [];
    const participation: ParticipationComputeRow[] = [];
    for (let i = 0; i < 24; i += 2) {
      rows.push(historyRow(i + 1), historyRow(i + 2));
      participation.push(part(i + 1, "A", "Cpu", 10), part(i + 2, "G", "Gpu", 7));
    }
    setParticipation(participation);
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
    setParticipation([part(1, "A", "Cpu", 10), part(2, "G", "Gpu", 7)]);
    const { client } = makeClient([historyRow(1), historyRow(2)]);
    const result = renderHook(client, "24h", "normalized");
    await settle();
    const cpu = result.current.series.find((s) => s.id === "CPU")!;
    expect(cpu.data.some((p) => p.y > 0)).toBe(true);
  });

  test("QPU estimate stays finite in every grouping/metric", async () => {
    setParticipation([part(1, "A", "Cpu", 10), part(2, "G", "Gpu", 7), part(3, "Q", "Qpu", 42)]);
    const rows = [historyRow(1), historyRow(2), historyRow(3, "5GQpu")];
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
