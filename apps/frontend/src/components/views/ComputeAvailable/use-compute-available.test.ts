// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "@/store/telemetry-store";
import type { NodeInfo, NodesSnapshot } from "@quip/shared/telemetry";

import {
  countCpus,
  FOURTEEN_DAYS_MS,
  isNodeActive,
  useComputeAvailable,
  type ComputeAvailability,
} from "./use-compute-available";

// Minimal NodeInfo factory — countCpus only reads `miners` + `systemInfo`.
function node(partial: Partial<NodeInfo>): NodeInfo {
  return {
    address: "5Test",
    status: "active",
    firstSeen: 0,
    lastSeen: 0,
    lastHeartbeat: null,
    ...partial,
  };
}

describe("countCpus", () => {
  it("uses the declared numCpus when a CPU miner provides it", () => {
    const n = node({
      miners: {
        a: { kind: "CPU", minerId: "a", numCpus: 4 },
        b: { kind: "CPU", minerId: "b", numCpus: 2 },
      },
      systemInfo: { cpu: { logicalCores: 64 } },
    });
    // Declared total (6) wins over logicalCores (64) — the tile measures mining
    // capacity, not host hardware.
    expect(countCpus(n)).toBe(6);
  });

  it("falls back to logicalCores when CPU miners declare no count", () => {
    const n = node({
      miners: { a: { kind: "CPU", minerId: "a" } },
      systemInfo: { cpu: { logicalCores: 8 } },
    });
    expect(countCpus(n)).toBe(8);
  });

  it("returns 0 when there is no CPU miner, even with logicalCores present", () => {
    const n = node({
      miners: { g: { kind: "GPU", minerId: "g" } },
      systemInfo: { cpu: { logicalCores: 16 } },
    });
    expect(countCpus(n)).toBe(0);
  });

  it("returns 0 when a CPU miner declares no count and there is no systemInfo", () => {
    const n = node({ miners: { a: { kind: "CPU", minerId: "a" } } });
    expect(countCpus(n)).toBe(0);
  });

  it("does not fall back when at least one CPU miner declares a count", () => {
    const n = node({
      miners: {
        a: { kind: "CPU", minerId: "a", numCpus: 8 },
        b: { kind: "CPU", minerId: "b" },
      },
      systemInfo: { cpu: { logicalCores: 32 } },
    });
    // sum > 0, so the fallback never engages; the undeclared miner contributes 0.
    expect(countCpus(n)).toBe(8);
  });
});

// ---- isNodeActive / 14-day windowing -------------------------------------

const NOW_MS = Date.parse("2026-07-06T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("isNodeActive", () => {
  it("is true for a node last seen 3 days ago", () => {
    const n = node({ lastSeen: Math.floor((NOW_MS - 3 * DAY_MS) / 1000) });
    expect(isNodeActive(n, NOW_MS)).toBe(true);
  });

  it("is true exactly at the 14-day boundary", () => {
    const n = node({ lastSeen: Math.floor((NOW_MS - FOURTEEN_DAYS_MS) / 1000) });
    expect(isNodeActive(n, NOW_MS)).toBe(true);
  });

  it("is false just past the 14-day boundary", () => {
    const n = node({ lastSeen: Math.floor((NOW_MS - FOURTEEN_DAYS_MS - 1000) / 1000) });
    expect(isNodeActive(n, NOW_MS)).toBe(false);
  });

  it("is false for a node last seen 20 days ago", () => {
    const n = node({ lastSeen: Math.floor((NOW_MS - 20 * DAY_MS) / 1000) });
    expect(isNodeActive(n, NOW_MS)).toBe(false);
  });
});

// ---- useComputeAvailable — 14-day activity window ------------------------

function makeSnapshot(nodes: Record<string, NodeInfo>): NodesSnapshot {
  return {
    updatedAt: new Date(NOW_MS).toISOString(),
    nodeCount: Object.keys(nodes).length,
    activeCount: Object.keys(nodes).length,
    nodes,
  };
}

function renderComputeAvailable(): { current: ComputeAvailability | null } {
  const result: { current: ComputeAvailability | null } = { current: null };

  function Probe(): null {
    result.current = useComputeAvailable();
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useTelemetryStore.setState({ nodes: null, serverTime: null, blocks: [] });
});

describe("useComputeAvailable — 14-day activity window", () => {
  const RECENT_SEC = Math.floor((NOW_MS - 3 * DAY_MS) / 1000);
  const STALE_SEC = Math.floor((NOW_MS - 20 * DAY_MS) / 1000);

  function activeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
    return node({
      address: "active-node",
      lastSeen: RECENT_SEC,
      systemInfo: {
        cpu: { logicalCores: 4, brand: "Intel Core i9-13900K" },
        gpus: [{ name: "NVIDIA RTX 4090" }],
      },
      miners: {
        "active-CPU-1": { kind: "CPU", minerId: "active-CPU-1", numCpus: 4 },
        "active-QPU-1": { kind: "QPU", minerId: "active-QPU-1" },
      },
      location: { country: "US", lat: 1, lng: 2 },
      ...overrides,
    });
  }

  function staleNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
    return node({
      address: "stale-node",
      lastSeen: STALE_SEC,
      systemInfo: {
        cpu: { logicalCores: 8, brand: "AMD EPYC" },
        gpus: [{ name: "NVIDIA RTX 3060" }],
      },
      miners: {
        "stale-CPU-1": { kind: "CPU", minerId: "stale-CPU-1", numCpus: 8 },
        "stale-QPU-1": { kind: "QPU", minerId: "stale-QPU-1" },
      },
      location: { country: "DE", lat: 3, lng: 4 },
      publicHost: "stale.example.com",
      ...overrides,
    });
  }

  it("excludes stale nodes from totalCpus/totalGpus/totalQpus/activeNodeCount", () => {
    useTelemetryStore.setState({
      serverTime: new Date(NOW_MS).toISOString(),
      nodes: makeSnapshot({ active: activeNode(), stale: staleNode() }),
    });

    const out = renderComputeAvailable().current!;
    expect(out.activeNodeCount).toBe(1);
    expect(out.totalCpus).toBe(4);
    expect(out.totalGpus).toBe(1);
    expect(out.totalQpus).toBe(1);
    // totalNodes stays the all-time count — unaffected by the 14-day window.
    expect(out.totalNodes).toBe(2);
  });

  it("excludes stale nodes from Est. PFLOPS but not from all-time networkTflops", () => {
    useTelemetryStore.setState({
      serverTime: new Date(NOW_MS).toISOString(),
      nodes: makeSnapshot({ active: activeNode(), stale: staleNode() }),
    });

    const out = renderComputeAvailable().current!;
    expect(out.totalPetaflops).toBeGreaterThan(0);
    // networkTflops (used for the block-ceiling PFLOP·s tiles, not shown in
    // NetworkView) stays scoped to ALL nodes — the stale node still
    // contributes there, so it must exceed the active-only totalPetaflops.
    expect(out.networkTflops).toBeGreaterThan(out.totalPetaflops * 1000);
  });

  it("excludes stale nodes from cpuModels/gpuModels breakdowns", () => {
    useTelemetryStore.setState({
      serverTime: new Date(NOW_MS).toISOString(),
      nodes: makeSnapshot({ active: activeNode(), stale: staleNode() }),
    });

    const out = renderComputeAvailable().current!;
    const cpuModelNames = out.cpuModels.map((m) => m.model);
    const gpuModelNames = out.gpuModels.map((m) => m.model);
    expect(cpuModelNames.some((m) => m.includes("EPYC"))).toBe(false);
    expect(gpuModelNames.some((m) => m.includes("3060"))).toBe(false);
  });

  it("excludes stale nodes from locatedNodes/unlocatedCount", () => {
    useTelemetryStore.setState({
      serverTime: new Date(NOW_MS).toISOString(),
      nodes: makeSnapshot({
        active: activeNode(),
        // Stale node has publicHost but no location — would normally bump
        // unlocatedCount, but the 14-day window excludes it entirely.
        stale: staleNode({ location: undefined }),
      }),
    });

    const out = renderComputeAvailable().current!;
    expect(out.locatedNodes).toHaveLength(1);
    expect(out.locatedNodes[0]?.address).toBe("active-node");
    expect(out.unlocatedCount).toBe(0);
  });

  it("includes all nodes when every node is within the 14-day window", () => {
    useTelemetryStore.setState({
      serverTime: new Date(NOW_MS).toISOString(),
      nodes: makeSnapshot({
        a: activeNode({ address: "a" }),
        b: activeNode({ address: "b", lastSeen: RECENT_SEC }),
      }),
    });

    const out = renderComputeAvailable().current!;
    expect(out.activeNodeCount).toBe(2);
    expect(out.totalNodes).toBe(2);
  });
});
