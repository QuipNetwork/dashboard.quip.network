// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BlockRecord, ChainMinerRecord, MinerHardwareRecord } from "@quip/shared/telemetry";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";

import { RECENT_QBLOCK_WINDOW, useMiningTime, type MiningTimeSeries } from "./use-mining-time";

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
    ...overrides,
  };
}

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

// DESC by block number (tip first), as the telemetry store ships them.
function makeDescBlocks(count: number, tip: number): BlockRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const n = tip - i;
    return makeBlock({
      blockHash: `0xblk${n}`,
      substrateBlockNumber: String(n),
      minerId: "5GCpu",
    });
  });
}

// ---- Harness -----------------------------------------------------------

function renderHook(): { current: MiningTimeSeries[] } {
  const result: { current: MiningTimeSeries[] } = { current: [] };

  function Probe(): null {
    result.current = useMiningTime();
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
  useTelemetryStore.setState({ blocks: [], chainMiners: [], nodeDescriptors: [] });
  useUIStore.setState({ aggregationMode: "byType", selectedTypes: ["CPU", "GPU", "QPU"] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ---- Tests -------------------------------------------------------------

describe("useMiningTime", () => {
  test("keeps only the most recent RECENT_QBLOCK_WINDOW qblocks", () => {
    const tip = 480_000;
    useTelemetryStore.setState({
      blocks: makeDescBlocks(RECENT_QBLOCK_WINDOW + 25, tip),
      chainMiners: [makeChainMiner()],
    });

    const cpu = renderHook().current.find((s) => s.id === "CPU");
    expect(cpu?.data.length).toBe(RECENT_QBLOCK_WINDOW);

    // The window drops the oldest 25 — the smallest x kept is the
    // RECENT_QBLOCK_WINDOW-th block counting back from the tip.
    const minX = Math.min(...(cpu?.data.map((p) => p.x) ?? []));
    expect(minX).toBe(tip - (RECENT_QBLOCK_WINDOW - 1));
  });

  test("returns all qblocks when fewer than the window exist", () => {
    useTelemetryStore.setState({
      blocks: makeDescBlocks(10, 480_000),
      chainMiners: [makeChainMiner()],
    });

    const cpu = renderHook().current.find((s) => s.id === "CPU");
    expect(cpu?.data.length).toBe(10);
  });
});
