// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import type { NodeInfo, NodesSnapshot } from "@quip/shared/telemetry";

import { NetworkView } from "./NetworkView";

// Default lastSeen is anchored to the real wall clock (not a fixed
// timestamp) so fixtures stay inside the 14-day activity window
// (`isNodeActive` in use-compute-available.ts) regardless of when the
// suite runs. Tests exercising the window itself override `lastSeen`
// explicitly alongside a fixed `serverTime` in the store.
function makeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    address: "5GAlice",
    status: "active",
    firstSeen: 1_700_000_000,
    lastSeen: Math.floor(Date.now() / 1000) - 3600,
    lastHeartbeat: 1_700_001_000,
    nodeName: "alice",
    systemInfo: {
      cpu: { logicalCores: 8, brand: "Intel Core i9-13900K" },
      memoryMb: 32_000,
      gpus: [{ name: "NVIDIA RTX 4090" }],
    },
    miners: {
      "alice-CPU-1": { kind: "CPU", minerId: "alice-CPU-1", numCpus: 8 },
      "alice-GPU-1": { kind: "GPU", minerId: "alice-GPU-1", backend: "cuda" },
    },
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

describe("NetworkView", () => {
  test("renders empty PFLOPS tile when no survey data has arrived", () => {
    useTelemetryStore.setState({ nodes: null });
    act(() => {
      root.render(createElement(NetworkView));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Est. PFLOPS");
    // No nodes ⇒ totalPetaflops=0.00. Use the surrounding "Across 0 active
    // nodes" sublabel as the canonical empty-state signal — "0.00" alone
    // could match other tiles.
    expect(text).toContain("Across 0 active nodes");
  });

  test("aggregates TFLOPS into the PFLOPS tile from NodesSnapshot", () => {
    useTelemetryStore.setState({
      nodes: makeSnapshot({ "5GAlice": makeNode() }),
    });
    act(() => {
      root.render(createElement(NetworkView));
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
      root.render(createElement(NetworkView));
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
      root.render(createElement(NetworkView));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Node Compute Contribution");
    expect(text).toContain("2 nodes, sorted by contribution");
  });

  test("hosts the node inventory: locations map and on-chain miners table", () => {
    useTelemetryStore.setState({ nodes: null });
    act(() => {
      root.render(createElement(NetworkView));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Node Locations");
    expect(text).toContain("On-chain miners");
  });

  // ---- relocated compute charts (bead 1o0.1) ------------------------------

  test("hosts Total Compute Used above the On-chain miners table", () => {
    useUIStore.setState({ aggregationMode: "byType" });
    useTelemetryStore.setState({ nodes: makeSnapshot({ "5GAlice": makeNode() }) });
    act(() => {
      root.render(createElement(NetworkView));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Total Compute Used");
    // Placement: the relocated chart sits above the On-chain miners section.
    expect(text.indexOf("Total Compute Used")).toBeLessThan(text.indexOf("On-chain miners"));
  });

  test("shows Mining Nodes by Type in byType mode and hides it in byNode mode", () => {
    useTelemetryStore.setState({ nodes: makeSnapshot({ "5GAlice": makeNode() }) });

    useUIStore.setState({ aggregationMode: "byType" });
    act(() => {
      root.render(createElement(NetworkView));
    });
    expect(container.textContent ?? "").toContain("Mining Nodes by Type");

    useUIStore.setState({ aggregationMode: "byNode" });
    act(() => {
      root.render(createElement(NetworkView));
    });
    expect(container.textContent ?? "").not.toContain("Mining Nodes by Type");
  });

  // ---- 14-day activity window (bead 1o0.3) --------------------------------

  const NOW_ISO = "2026-07-06T00:00:00.000Z";
  const NOW_MS = Date.parse(NOW_ISO);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const RECENT_SEC = Math.floor((NOW_MS - 3 * DAY_MS) / 1000);
  const STALE_SEC = Math.floor((NOW_MS - 20 * DAY_MS) / 1000);

  test("labels the windowed surfaces with a last-2-weeks qualifier", () => {
    useUIStore.setState({ aggregationMode: "byType" });
    useTelemetryStore.setState({
      serverTime: NOW_ISO,
      nodes: makeSnapshot({ "5GAlice": makeNode({ lastSeen: RECENT_SEC }) }),
    });
    act(() => {
      root.render(createElement(NetworkView));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Node Locations (last 2 weeks)");
    expect(text).toContain("Total CPUs (last 2 weeks)");
    expect(text).toContain("Total GPUs (last 2 weeks)");
    expect(text).toContain("Total QPUs (last 2 weeks)");
    expect(text).toContain("Est. PFLOPS (last 2 weeks)");
    expect(text).toContain("CPU Model Breakdown (last 2 weeks)");
    expect(text).toContain("GPU Model Breakdown (last 2 weeks)");
  });

  test("excludes nodes stale for 14+ days from Total CPUs/GPUs/QPUs and hardware breakdowns", () => {
    useUIStore.setState({ aggregationMode: "byType" });
    useTelemetryStore.setState({
      serverTime: NOW_ISO,
      nodes: makeSnapshot({
        "5GAlice": makeNode({
          address: "5GAlice",
          lastSeen: RECENT_SEC,
          systemInfo: {
            cpu: { logicalCores: 4, brand: "Intel Core i9-13900K" },
            gpus: [{ name: "NVIDIA RTX 4090" }],
          },
          miners: {
            "alice-CPU-1": { kind: "CPU", minerId: "alice-CPU-1", numCpus: 4 },
          },
        }),
        "5GStale": makeNode({
          address: "5GStale",
          lastSeen: STALE_SEC,
          systemInfo: {
            cpu: { logicalCores: 99, brand: "AMD EPYC" },
            gpus: [{ name: "NVIDIA RTX 3060" }],
          },
          miners: {
            "stale-CPU-1": { kind: "CPU", minerId: "stale-CPU-1", numCpus: 99 },
          },
        }),
      }),
    });
    act(() => {
      root.render(createElement(NetworkView));
    });
    const text = container.textContent ?? "";
    // The stale node's 99 declared CPUs must not appear in the total.
    expect(text).not.toContain("103");
    expect(text).toContain("4");
    // Stale node's GPU/CPU models are excluded from the breakdown charts.
    expect(text).not.toContain("EPYC");
    expect(text).not.toContain("3060");
  });
});
