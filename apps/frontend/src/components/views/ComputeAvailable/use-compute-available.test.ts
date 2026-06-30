// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { NodeInfo } from "@quip/shared/telemetry";

import { countCpus } from "./use-compute-available";

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
