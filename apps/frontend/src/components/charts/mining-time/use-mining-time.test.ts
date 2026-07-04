// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Range-windowed mining-time series: the hook fetches /api/mining-history for
// the selected window and groups rows locally — "byType" into CPU/GPU/QPU
// lines (filtered by the global type selection), "all" into one aggregate
// line. x is the on-chain qblock id, y the mining time in seconds.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ServicesProvider } from "@/services/services-provider";
import type { TelemetryClient } from "@/services/telemetry-client";
import { idleTelemetryClient } from "@/testing/services";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import type {
  ChainMinerRecord,
  MinerHardwareRecord,
  MiningHistoryRow,
} from "@quip/shared/telemetry";

import { useMiningTime, type MiningTimeGrouping, type MiningTimeState } from "./use-mining-time";

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
  useTelemetryStore.setState({ chainMiners: [cpuMiner, gpuMiner], nodeDescriptors: [] });
  useUIStore.setState({ selectedTypes: ["CPU", "GPU", "QPU"] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useTelemetryStore.setState({ chainMiners: [], nodeDescriptors: [] });
});

function renderHook(
  client: TelemetryClient,
  range: "1h" | "24h",
  grouping: MiningTimeGrouping,
): { current: MiningTimeState } {
  const result = { current: {} as MiningTimeState };
  function Probe(): null {
    result.current = useMiningTime(range, grouping, { now: () => NOW });
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
});
