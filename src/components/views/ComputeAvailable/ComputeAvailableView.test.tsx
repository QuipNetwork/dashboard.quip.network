// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "../../../store/telemetry-store";
import { useUIStore } from "../../../store/ui-store";
import type { NodeInfo, NodesSnapshot } from "../../../types/telemetry";

import { ComputeAvailableView } from "./ComputeAvailableView";

function makeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    address: "5GAlice",
    status: "active",
    firstSeen: 1_700_000_000,
    lastSeen: 1_700_001_000,
    lastHeartbeat: 1_700_001_000,
    nodeName: "alice",
    systemInfo: {
      cpu: { logicalCores: 8, brand: "Intel Core i9-13900K" },
      memoryMb: 32_000,
      gpus: [{ name: "NVIDIA RTX 4090" }],
    },
    miners: [
      { kind: "CPU", label: "alice-CPU-1" },
      { kind: "GPU", label: "alice-GPU-1", backend: "cuda" },
    ],
    ...overrides,
  };
}

function makeSnapshot(nodes: Record<string, NodeInfo>): NodesSnapshot {
  return {
    updatedAt: new Date(1_700_002_000_000).toISOString(),
    nodeCount: Object.keys(nodes).length,
    activeCount: Object.values(nodes).filter((n) => n.status === "active").length,
    nodes,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useTelemetryStore.setState({
    blocks: [],
    chainMiners: [],
    recentDifficulty: [],
    nodes: null,
    serverTime: null,
  });
  useUIStore.setState({ aggregationMode: "byType" });
});

describe("ComputeAvailableView", () => {
  test("renders empty PFLOPS tile when no survey data has arrived", () => {
    useTelemetryStore.setState({ nodes: null });
    act(() => {
      root.render(createElement(ComputeAvailableView));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Est. PFLOPS");
    // No nodes ⇒ totalPetaflops=0.00. Use the surrounding "Across 0 nodes"
    // sublabel as the canonical empty-state signal — "0.00" alone could
    // match other tiles.
    expect(text).toContain("Across 0 nodes");
  });

  test("aggregates TFLOPS into the PFLOPS tile from NodesSnapshot", () => {
    useTelemetryStore.setState({
      nodes: makeSnapshot({ "5GAlice": makeNode() }),
    });
    act(() => {
      root.render(createElement(ComputeAvailableView));
    });
    const text = container.textContent ?? "";
    // RTX 4090 is 82.6 TFLOPS + i9 (8 cores × 0.09) = 0.72 TFLOPS → 83.32
    // TFLOPS total = 0.08 PFLOPS. Format is "0.08" with the two-decimal
    // toFixed in the view.
    expect(text).toContain("Est. PFLOPS");
    expect(text).toContain("0.08");
  });

  test("shows hardware breakdown bars in byType mode", () => {
    useUIStore.setState({ aggregationMode: "byType" });
    useTelemetryStore.setState({
      nodes: makeSnapshot({ "5GAlice": makeNode() }),
    });
    act(() => {
      root.render(createElement(ComputeAvailableView));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("CPU Model Breakdown");
    expect(text).toContain("GPU Model Breakdown");
  });

  test("shows Node Compute Contribution leaderboard in byNode mode", () => {
    useUIStore.setState({ aggregationMode: "byNode" });
    useTelemetryStore.setState({
      nodes: makeSnapshot({
        "5GAlice": makeNode({ address: "5GAlice", nodeName: "alice" }),
        "5GBob": makeNode({ address: "5GBob", nodeName: "bob" }),
      }),
    });
    act(() => {
      root.render(createElement(ComputeAvailableView));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Node Compute Contribution");
    expect(text).toContain("2 nodes, sorted by contribution");
  });
});
