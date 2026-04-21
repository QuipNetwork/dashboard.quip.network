// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { NodeInfo, NodesSnapshot } from "../types/telemetry";

import { buildUnitCountIndex, getUnitCount } from "./units";

function makeSnapshot(nodes: Record<string, NodeInfo>): NodesSnapshot {
  return {
    updatedAt: "2025-01-01T00:00:00.000Z",
    nodeCount: Object.keys(nodes).length,
    activeCount: Object.keys(nodes).length,
    nodes,
  };
}

function makeNode(miners: NodeInfo["miners"]): NodeInfo {
  return {
    address: "addr",
    status: "online",
    firstSeen: 0,
    lastSeen: 0,
    lastHeartbeat: null,
    miners,
  };
}

describe("buildUnitCountIndex", () => {
  it("returns an empty map for null input", () => {
    expect(buildUnitCountIndex(null).size).toBe(0);
  });

  it("counts CPU miners by numCpus", () => {
    const idx = buildUnitCountIndex(
      makeSnapshot({
        n1: makeNode({
          "cpu-1": { kind: "CPU", minerId: "cpu-1", numCpus: 8 },
        }),
      }),
    );
    expect(idx.get("cpu-1")).toBe(8);
  });

  it("defaults CPU miners without numCpus to 1", () => {
    const idx = buildUnitCountIndex(
      makeSnapshot({
        n1: makeNode({ "cpu-1": { kind: "CPU", minerId: "cpu-1" } }),
      }),
    );
    expect(idx.get("cpu-1")).toBe(1);
  });

  it("counts each GPU entry as 1 (v0.1 API enumerates per-device)", () => {
    const idx = buildUnitCountIndex(
      makeSnapshot({
        n1: makeNode({
          "gpu-0": { kind: "GPU", minerId: "gpu-0", deviceIndex: 0 },
          "gpu-1": { kind: "GPU", minerId: "gpu-1", deviceIndex: 1 },
        }),
      }),
    );
    expect(idx.get("gpu-0")).toBe(1);
    expect(idx.get("gpu-1")).toBe(1);
  });

  it("counts QPU entries as 1", () => {
    const idx = buildUnitCountIndex(
      makeSnapshot({
        n1: makeNode({
          "qpu-1": { kind: "QPU", minerId: "qpu-1", provider: "dwave" },
        }),
      }),
    );
    expect(idx.get("qpu-1")).toBe(1);
  });

  it("covers miners across multiple nodes", () => {
    const idx = buildUnitCountIndex(
      makeSnapshot({
        a: makeNode({ "cpu-a": { kind: "CPU", minerId: "cpu-a", numCpus: 4 } }),
        b: makeNode({ "cpu-b": { kind: "CPU", minerId: "cpu-b", numCpus: 16 } }),
      }),
    );
    expect(idx.get("cpu-a")).toBe(4);
    expect(idx.get("cpu-b")).toBe(16);
  });
});

describe("getUnitCount", () => {
  it("falls back to 1 for an unknown minerId", () => {
    const idx = new Map<string, number>([["known", 4]]);
    expect(getUnitCount({ minerId: "unknown" }, idx)).toBe(1);
  });

  it("returns the indexed count for a known minerId", () => {
    const idx = new Map<string, number>([["m", 8]]);
    expect(getUnitCount({ minerId: "m" }, idx)).toBe(8);
  });
});
