// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord, ChainMinerRecord, MinerHardwareRecord } from "@quip/shared/telemetry";
import { QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN } from "@/lib/device-access-time";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";

import { useComputeUsed, type ComputeUsedEntry } from "./use-compute-used";

// ---- Fixtures ----------------------------------------------------------

function makeBlock(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xhash",
    substrateBlockNumber: "100",
    substrateBlockHash: "0xshash",
    substrateParentHash: "0xparent",
    timestamp: 1_700_000_000,
    minerId: "5GCpu",
    energy: -100,
    diversity: 0.5,
    numValidSolutions: 1,
    miningTime: 60,
    reward: "1000000000000",
    qblockId: "1",
    nonce: "1",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -110,
    minDiversity: 0.1,
    minSolutions: 1,
    topologyHash: null,
    finalized: false,
    deviceAccessTimeUs: null,
    ...overrides,
  };
}

function makeHardware(overrides: Partial<MinerHardwareRecord>): MinerHardwareRecord {
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
    hardware: makeHardware({}),
    ...overrides,
  };
}

function qpuMiner(accountId: string): ChainMinerRecord {
  return makeChainMiner({
    accountId,
    hardware: makeHardware({
      accountId,
      primaryType: "QPU",
      miners: [{ id: "qpu-1", type: "QPU" }],
    }),
  });
}

// ---- Harness -----------------------------------------------------------

function renderHook(): { current: ComputeUsedEntry[] } {
  const result: { current: ComputeUsedEntry[] } = { current: [] };

  function Probe(): null {
    result.current = useComputeUsed();
    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });

  return result;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useTelemetryStore.setState({
    blocks: [],
    chainMiners: [],
    nodeDescriptors: [],
    recentMiningSubmissions: [],
  });
  useUIStore.setState({ aggregationMode: "byType", selectedTypes: ["CPU", "GPU", "QPU"] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ---- Tests -------------------------------------------------------------

describe("useComputeUsed", () => {
  test("reported deviceAccessTimeUs is used directly, not estimated", () => {
    useTelemetryStore.setState({
      blocks: [
        makeBlock({
          blockHash: "0xc1",
          minerId: "5GCpu",
          miningTime: 999,
          deviceAccessTimeUs: 45_000_000,
        }),
      ],
      chainMiners: [makeChainMiner({})],
    });

    const cpu = renderHook().current.find((e) => e.minerType === "CPU");
    expect(cpu?.compute).toBe(45); // 45_000_000us -> 45s, not the 999s miningTime
    expect(cpu?.estimated).toBe(false);
  });

  test("missing access time: CPU/GPU fall back to miningTime, QPU to the documented constant", () => {
    useTelemetryStore.setState({
      blocks: [
        makeBlock({ blockHash: "0xc1", minerId: "5GCpu", miningTime: 60 }),
        makeBlock({ blockHash: "0xg1", minerId: "5GGpu", miningTime: 30 }),
        makeBlock({ blockHash: "0xq1", minerId: "5GQpu", miningTime: 1200 }),
      ],
      chainMiners: [
        makeChainMiner({}),
        makeChainMiner({
          accountId: "5GGpu",
          hardware: makeHardware({
            accountId: "5GGpu",
            primaryType: "GPU",
            miners: [{ id: "gpu-1", type: "GPU" }],
          }),
        }),
        qpuMiner("5GQpu"),
      ],
    });

    const entries = renderHook().current;
    expect(entries.find((e) => e.minerType === "CPU")?.compute).toBe(60);
    expect(entries.find((e) => e.minerType === "GPU")?.compute).toBe(30);
    const qpu = entries.find((e) => e.minerType === "QPU");
    expect(qpu?.compute).toBe(QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN);
    expect(qpu?.estimated).toBe(true);
  });

  test("zero QPU wins still produce a labeled QPU entry with value 0", () => {
    useTelemetryStore.setState({
      blocks: [makeBlock({ blockHash: "0xc1", minerId: "5GCpu", miningTime: 60 })],
      chainMiners: [makeChainMiner({})],
    });

    const qpu = renderHook().current.find((e) => e.minerType === "QPU");
    expect(qpu).toBeDefined();
    expect(qpu?.compute).toBe(0);
    expect(qpu?.displayCompute).toBe(0);
    expect(qpu?.floored).toBe(false);
  });

  test("a tiny-but-real QPU total is floored to a visible bar height next to a huge CPU total", () => {
    useTelemetryStore.setState({
      blocks: [
        makeBlock({ blockHash: "0xc1", minerId: "5GCpu", miningTime: 100_000 }),
        makeBlock({
          blockHash: "0xq1",
          minerId: "5GQpu",
          deviceAccessTimeUs: 50_000, // 0.05s — real, but invisible next to 100_000s
        }),
      ],
      chainMiners: [makeChainMiner({}), qpuMiner("5GQpu")],
    });

    const entries = renderHook().current;
    const qpu = entries.find((e) => e.minerType === "QPU");
    expect(qpu?.compute).toBeCloseTo(0.05, 6); // true value unchanged
    expect(qpu?.floored).toBe(true);
    expect(qpu?.displayCompute).toBeGreaterThan(qpu!.compute); // plotted height raised
  });

  test("estimated marker surfaces when access time is unreported (null)", () => {
    useTelemetryStore.setState({
      blocks: [
        makeBlock({
          blockHash: "0xc1",
          minerId: "5GCpu",
          miningTime: 60,
          deviceAccessTimeUs: null,
        }),
      ],
      chainMiners: [makeChainMiner({})],
    });

    const cpu = renderHook().current.find((e) => e.minerType === "CPU");
    expect(cpu?.estimated).toBe(true);
  });

  test("CPU/GPU bars are unaffected by having no local mining_submissions data", () => {
    useTelemetryStore.setState({
      blocks: [
        makeBlock({ blockHash: "0xc1", minerId: "5GCpu", miningTime: 100 }),
        makeBlock({ blockHash: "0xg1", minerId: "5GGpu", miningTime: 50 }),
      ],
      chainMiners: [
        makeChainMiner({}),
        makeChainMiner({
          accountId: "5GGpu",
          hardware: makeHardware({
            accountId: "5GGpu",
            primaryType: "GPU",
            miners: [{ id: "gpu-1", type: "GPU" }],
          }),
        }),
      ],
    });

    const entries = renderHook().current;
    expect(entries.find((e) => e.minerType === "CPU")?.compute).toBe(100);
    expect(entries.find((e) => e.minerType === "GPU")?.compute).toBe(50);
  });
});
