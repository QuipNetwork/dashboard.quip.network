import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { BlockRecord, NodesSnapshot } from "../types/telemetry";
import { useTelemetryStore } from "../store/telemetry-store";
import { useUIStore } from "../store/ui-store";

function makeBlock(
  overrides: Partial<BlockRecord> & Pick<BlockRecord, "blockIndex" | "minerCategory" | "minerId">,
): BlockRecord {
  return {
    epoch: 1700000000,
    blockHash: `hash-${overrides.blockIndex}`,
    timestamp: 1700000000 + overrides.blockIndex * 60,
    previousHash: `prev-${overrides.blockIndex}`,
    ecdsaPublicKey: "04deadbeef",
    energy: 0.5,
    diversity: 0.3,
    numValidSolutions: 1,
    miningTime: 12,
    nonce: "42",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: 0.4,
    minDiversity: 0.2,
    minSolutions: 1,
    ...overrides,
  };
}

const MOCK_BLOCKS: BlockRecord[] = [
  makeBlock({ blockIndex: 0, minerCategory: "GPU", minerId: "gpu-miner-1" }),
  makeBlock({ blockIndex: 1, minerCategory: "CPU", minerId: "cpu-miner-1" }),
  makeBlock({ blockIndex: 2, minerCategory: "QPU", minerId: "qpu-miner-1" }),
  makeBlock({ blockIndex: 3, minerCategory: "GPU", minerId: "gpu-miner-2" }),
  makeBlock({ blockIndex: 4, minerCategory: "CPU", minerId: "cpu-miner-2" }),
  makeBlock({ blockIndex: 5, minerCategory: "QPU", minerId: "qpu-miner-1" }),
];

const MOCK_NODES: NodesSnapshot = {
  updatedAt: "2025-01-01T00:00:00Z",
  nodeCount: 5,
  activeCount: 4,
  nodes: {},
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  useTelemetryStore.setState({
    blocks: [],
    nodes: null,
    selfAddress: null,
    loading: true,
    error: null,
  });
  // Smoke test asserts against the Network view's chart grid; the default
  // viewMode is "my-node" which doesn't render those charts.
  useUIStore.setState({ viewMode: "network" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("App smoke test", () => {
  test("renders all four charts after fetching telemetry", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ blocks: MOCK_BLOCKS, nodes: MOCK_NODES, selfAddress: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const App = (await import("../App")).default;

    await act(async () => {
      root.render(createElement(App));
    });

    expect(fetchSpy).toHaveBeenCalledWith("/api/telemetry");
    expect(container.querySelector('[data-qa="chart-blocks-over-time"]')).not.toBeNull();
    expect(container.querySelector('[data-qa="chart-mining-time"]')).not.toBeNull();
    expect(container.querySelector('[data-qa="chart-compute-used"]')).not.toBeNull();
    expect(container.querySelector('[data-qa="chart-active-nodes"]')).not.toBeNull();

    fetchSpy.mockRestore();
  });
});
