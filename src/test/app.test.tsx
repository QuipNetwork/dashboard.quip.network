// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { BlockRecord, TelemetryResponse } from "../types/telemetry";
import { useTelemetryStore } from "../store/telemetry-store";
import { useUIStore } from "../store/ui-store";

function makeBlock(overrides: Partial<BlockRecord> & Pick<BlockRecord, "minerId">): BlockRecord {
  const n = overrides.substrateBlockNumber ?? "0";
  return {
    blockHash: `hash-${n}`,
    substrateBlockNumber: n,
    substrateBlockHash: `sub-hash-${n}`,
    substrateParentHash: `sub-parent-${n}`,
    timestamp: 1700000000 + Number(n) * 60,
    energy: 0.5,
    diversity: 0.3,
    numValidSolutions: 1,
    qualityMilli: 800,
    miningTime: 12,
    reward: "1000000000000",
    nonce: "42",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: 0.4,
    minDiversity: 0.2,
    minSolutions: 1,
    finalized: false,
    ...overrides,
  };
}

const MOCK_BLOCKS: BlockRecord[] = [
  makeBlock({ substrateBlockNumber: "5", minerId: "qpu-miner-1" }),
  makeBlock({ substrateBlockNumber: "4", minerId: "cpu-miner-2" }),
  makeBlock({ substrateBlockNumber: "3", minerId: "gpu-miner-2" }),
  makeBlock({ substrateBlockNumber: "2", minerId: "qpu-miner-1" }),
  makeBlock({ substrateBlockNumber: "1", minerId: "cpu-miner-1" }),
  makeBlock({ substrateBlockNumber: "0", minerId: "gpu-miner-1" }),
];

const MOCK_RESPONSE: TelemetryResponse = {
  blocks: MOCK_BLOCKS,
  selfAddress: null,
  indexer: null,
  serverTime: "2025-01-01T00:00:00Z",
  chainHead: null,
  babeEpoch: null,
  babeAuthorities: [],
  chainMiners: [],
  recentDifficulty: [],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  useTelemetryStore.setState({
    blocks: [],
    selfAddress: null,
    indexer: null,
    serverTime: null,
    chainHead: null,
    babeEpoch: null,
    babeAuthorities: [],
    chainMiners: [],
    recentDifficulty: [],
    loading: true,
    error: null,
  });
  // Smoke test asserts against the Network view's chart grid; the default
  // viewMode is "my-node" which doesn't render those charts. With the v0.3
  // transitional category model, blocks with no chain-miner row resolve to
  // "OTHER" — include it in selectedTypes so the byType-keyed charts have
  // data to render in the absence of per-miner hardware.
  useUIStore.setState({
    viewMode: "network",
    selectedTypes: ["CPU", "GPU", "QPU", "OTHER"],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("App smoke test", () => {
  test("renders the network view's chart grid after fetching telemetry", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      return Promise.resolve(
        new Response(JSON.stringify(MOCK_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch);

    const App = (await import("../App")).default;

    await act(async () => {
      root.render(createElement(App));
    });
    // Flush the fetchTelemetry microtask so the loading flag flips and the
    // network view actually mounts.
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenCalledWith("/api/telemetry");
    expect(container.querySelector('[data-qa="chart-blocks-over-time"]')).not.toBeNull();
    expect(container.querySelector('[data-qa="chart-mining-time"]')).not.toBeNull();
    expect(container.querySelector('[data-qa="chart-compute-used"]')).not.toBeNull();
    expect(container.querySelector('[data-qa="chart-active-nodes"]')).not.toBeNull();

    fetchSpy.mockRestore();
  });
});
