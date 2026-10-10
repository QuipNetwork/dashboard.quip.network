// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Estimated electrical energy per qblock, stacked by processor type. The
// mining-history rows bound the window and order the x-axis; the values come
// from store.participationCompute at category default watts × energySeconds.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { estimateDeviceWatts, estimateEnergyJoules, QPU_SYSTEM_WATTS } from "@/lib/hardware-power";
import { ServicesProvider } from "@/services/services-provider";
import type { TelemetryClient } from "@/services/telemetry-client";
import { idleTelemetryClient } from "@/testing/services";
import { useTelemetryStore } from "@/store/telemetry-store";
import {
  QPU_RESERVED_SECONDS_PER_QBLOCK,
  type MiningHistoryRow,
  type ParticipationComputeRow,
} from "@quip/shared/telemetry";

import { useEnergyPerQblock, type EnergyPerQblockState } from "./use-energy-per-qblock";

const NOW = Date.parse("2026-07-02T12:00:00.000Z");

const historyRow = (qblockId: number): MiningHistoryRow => ({
  qblockId: String(qblockId),
  substrateBlockNumber: String(500_000 + qblockId),
  timestamp: 1_751_457_000 + qblockId,
  minerId: "5GCpu",
  miningTime: 0,
});

const part = (
  qblockId: number,
  account: string,
  kind: string,
  miningSeconds: number,
): ParticipationComputeRow => ({
  qblockId: String(qblockId),
  account,
  kind,
  miningSeconds,
  exactQpuAccessUs: null,
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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useTelemetryStore.setState({ participationCompute: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useTelemetryStore.setState({ participationCompute: [] });
});

function renderHook(client: TelemetryClient): { current: EnergyPerQblockState } {
  const result = { current: {} as EnergyPerQblockState };
  function Probe(): null {
    result.current = useEnergyPerQblock("24h", { now: () => NOW });
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

const cpuJoules = (seconds: number): number =>
  estimateEnergyJoules(estimateDeviceWatts("CPU", null), seconds);
const gpuJoules = (seconds: number): number =>
  estimateEnergyJoules(estimateDeviceWatts("GPU", null), seconds);
const qpuJoules = (): number =>
  estimateEnergyJoules(estimateDeviceWatts("QPU", null), QPU_RESERVED_SECONDS_PER_QBLOCK);

describe("useEnergyPerQblock", () => {
  test("fetches the selected window's cutoff", async () => {
    const { client, calls } = makeClient([]);
    renderHook(client);
    await settle();
    expect(calls).toEqual(["2026-07-01T12:00:00.000Z"]);
  });

  test("stacks every participant's joules per type per qblock on the energy-seconds basis", async () => {
    useTelemetryStore.setState({
      participationCompute: [
        part(1, "A", "Cpu", 10),
        part(1, "B", "Cpu", 5),
        part(1, "Q", "QpuDwave", 999),
      ],
    });
    const { client } = makeClient([historyRow(1)]);
    const result = renderHook(client);
    await settle();
    expect(result.current.loading).toBe(false);
    expect(result.current.series).toEqual([
      { id: "CPU", data: [{ x: 1, y: cpuJoules(15) }] },
      { id: "QPU", data: [{ x: 1, y: qpuJoules() }] },
    ]);
    expect(result.current.totalJoules).toBeCloseTo(cpuJoules(15) + qpuJoules());
  });

  test("charges the block-active window for a QPU qblock shorter than its reservation", async () => {
    const miningSeconds = 10;
    useTelemetryStore.setState({
      participationCompute: [part(1, "Q", "QpuDwave", miningSeconds)],
    });
    const { client } = makeClient([historyRow(1)]);
    const result = renderHook(client);
    await settle();
    const joules = QPU_SYSTEM_WATTS * miningSeconds;
    expect(result.current.series).toEqual([{ id: "QPU", data: [{ x: 1, y: joules }] }]);
    expect(result.current.totalJoules).toBe(joules);
  });

  test("a type absent from a qblock keeps a zero point so the stacks align", async () => {
    useTelemetryStore.setState({
      participationCompute: [part(1, "A", "Cpu", 10), part(2, "G", "Gpu", 7)],
    });
    const { client } = makeClient([historyRow(1), historyRow(2)]);
    const result = renderHook(client);
    await settle();
    expect(result.current.series).toEqual([
      {
        id: "CPU",
        data: [
          { x: 1, y: cpuJoules(10) },
          { x: 2, y: 0 },
        ],
      },
      {
        id: "GPU",
        data: [
          { x: 1, y: 0 },
          { x: 2, y: gpuJoules(7) },
        ],
      },
    ]);
  });

  test("qblocks in range without participation rows contribute no point", async () => {
    useTelemetryStore.setState({ participationCompute: [part(2, "A", "Cpu", 10)] });
    const { client } = makeClient([historyRow(1), historyRow(2)]);
    const result = renderHook(client);
    await settle();
    expect(result.current.series).toEqual([{ id: "CPU", data: [{ x: 2, y: cpuJoules(10) }] }]);
    expect(result.current.isEmpty).toBe(false);
    expect(result.current.plottedQblocks).toBe(1);
    expect(result.current.rangeQblocks).toBe(2);
    expect(result.current.bucketSize).toBe(1);
    expect(result.current.totalJoules).toBe(cpuJoules(10));
  });

  test("bounds 5,000 plotted qblocks per series while retaining the exact unbucketed total", async () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => historyRow(i + 1));
    useTelemetryStore.setState({
      participationCompute: rows.flatMap((row) => [
        part(Number(row.qblockId), "A", "Cpu", Number(row.qblockId)),
        part(Number(row.qblockId), "G", "Gpu", 7),
      ]),
    });
    const { client } = makeClient(rows);
    const result = renderHook(client);
    await settle();

    expect(result.current.series).toHaveLength(2);
    for (const series of result.current.series) {
      expect(series.data.length).toBeLessThanOrEqual(600);
      expect(series.data[0]?.x).toBe(9);
      expect(series.data.at(-1)?.x).toBe(5_000);
    }
    expect(result.current.series[0]?.data[0]?.y).toBe(cpuJoules(5));
    const rawTotal = rows.reduce(
      (sum, row) => sum + cpuJoules(Number(row.qblockId)) + gpuJoules(7),
      0,
    );
    expect(result.current.totalJoules).toBe(rawTotal);
    expect(result.current.bucketSize).toBe(9);
    expect(result.current.plottedQblocks).toBe(5_000);
    expect(result.current.rangeQblocks).toBe(5_000);
  });

  test("no rows in range is empty with a zero total", async () => {
    const { client } = makeClient([]);
    const result = renderHook(client);
    await settle();
    expect(result.current.series).toEqual([]);
    expect(result.current.totalJoules).toBe(0);
    expect(result.current.isEmpty).toBe(true);
    expect(result.current.bucketSize).toBe(1);
    expect(result.current.plottedQblocks).toBe(0);
    expect(result.current.rangeQblocks).toBe(0);
  });
});
