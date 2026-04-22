// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { estimateNodeFlops, lookupCpu, lookupGpu } from "../../../lib/hardware-flops";
import { useTelemetryStore } from "../../../store/telemetry-store";
import type { NodeInfo } from "../../../types/telemetry";

export interface ModelBreakdown {
  model: string;
  count: number;
  tflops: number;
}

export interface LocatedNode {
  address: string;
  nodeName: string;
  country: string;
  city?: string;
  lat: number;
  lng: number;
  tflops: number;
}

export interface PerNodeTflops {
  address: string;
  nodeName: string;
  tflops: number;
}

export interface ComputeAvailability {
  totalNodes: number;
  totalCpus: number;
  totalGpus: number;
  totalQpus: number;
  totalPetaflops: number;
  cpuModels: ModelBreakdown[];
  gpuModels: ModelBreakdown[];
  locatedNodes: LocatedNode[];
  unlocatedCount: number;
  perNodeTflops: PerNodeTflops[]; // sorted desc by tflops
  topNode: PerNodeTflops | null;
  medianNodeTflops: number;
}

export function useComputeAvailable(): ComputeAvailability {
  const nodes = useTelemetryStore((s) => s.nodes);

  return useMemo<ComputeAvailability>(() => {
    if (!nodes) return EMPTY;

    let totalCpus = 0;
    let totalGpus = 0;
    let totalQpus = 0;
    let totalTflops = 0;
    const cpuCounts = new Map<string, { count: number; tflops: number }>();
    const gpuCounts = new Map<string, { count: number; tflops: number }>();
    const located: LocatedNode[] = [];
    const perNode: PerNodeTflops[] = [];
    let unlocated = 0;

    for (const node of Object.values(nodes.nodes)) {
      totalCpus += countCpus(node);
      totalGpus += node.systemInfo?.gpus?.length ?? 0;
      totalQpus += countQpus(node);

      const flops = estimateNodeFlops(node);
      totalTflops += flops.totalTflops;

      perNode.push({
        address: node.address,
        nodeName: node.nodeName ?? node.address.slice(0, 10),
        tflops: flops.totalTflops,
      });

      // CPU buckets
      const cpuMatch = lookupCpu(node.systemInfo?.cpu);
      if (cpuMatch.canonical !== "Unknown CPU" || cpuMatch.tflops > 0) {
        bump(cpuCounts, cpuMatch.canonical, 1, cpuMatch.tflops);
      }

      // GPU buckets — one entry per device
      for (const gpu of node.systemInfo?.gpus ?? []) {
        const match = lookupGpu(gpu.name);
        bump(gpuCounts, match.canonical, 1, match.tflops);
      }

      if (node.location) {
        located.push({
          address: node.address,
          nodeName: node.nodeName ?? node.address.slice(0, 10),
          country: node.location.country,
          city: node.location.city,
          lat: node.location.lat,
          lng: node.location.lng,
          tflops: flops.totalTflops,
        });
      } else if (node.publicHost) {
        // publicHost exists but couldn't be geo-located — counts toward the
        // "unlocated" tally so the map's empty state explains the gap.
        unlocated += 1;
      }
    }

    perNode.sort((a, b) => b.tflops - a.tflops);

    return {
      totalNodes: Object.keys(nodes.nodes).length,
      totalCpus,
      totalGpus,
      totalQpus,
      totalPetaflops: totalTflops / 1000,
      cpuModels: toBreakdown(cpuCounts),
      gpuModels: toBreakdown(gpuCounts),
      locatedNodes: located,
      unlocatedCount: unlocated,
      perNodeTflops: perNode,
      topNode: perNode[0] ?? null,
      medianNodeTflops: median(perNode.map((n) => n.tflops)),
    };
  }, [nodes]);
}

const EMPTY: ComputeAvailability = {
  totalNodes: 0,
  totalCpus: 0,
  totalGpus: 0,
  totalQpus: 0,
  totalPetaflops: 0,
  cpuModels: [],
  gpuModels: [],
  locatedNodes: [],
  unlocatedCount: 0,
  perNodeTflops: [],
  topNode: null,
  medianNodeTflops: 0,
};

function countCpus(node: NodeInfo): number {
  // Prefer systemInfo.cpu.logicalCores (authoritative per-host count); fall
  // back to summing numCpus across CPU miner entries when systemInfo is
  // absent on older nodes.
  if (typeof node.systemInfo?.cpu?.logicalCores === "number") {
    return node.systemInfo.cpu.logicalCores;
  }
  let sum = 0;
  for (const m of Object.values(node.miners ?? {})) {
    if (m.kind === "CPU" && typeof m.numCpus === "number") sum += m.numCpus;
  }
  return sum;
}

function countQpus(node: NodeInfo): number {
  let sum = 0;
  for (const m of Object.values(node.miners ?? {})) {
    if (m.kind === "QPU") sum += 1;
  }
  return sum;
}

function bump(
  map: Map<string, { count: number; tflops: number }>,
  key: string,
  count: number,
  tflops: number,
): void {
  const existing = map.get(key);
  if (existing) {
    existing.count += count;
    existing.tflops += tflops;
  } else {
    map.set(key, { count, tflops });
  }
}

function toBreakdown(map: Map<string, { count: number; tflops: number }>): ModelBreakdown[] {
  return [...map.entries()]
    .map(([model, v]) => ({ model, count: v.count, tflops: v.tflops }))
    .sort((a, b) => b.count - a.count);
}

// Median over all nodes (including zero-TFLOPS nodes). Every node has a
// non-zero estimate in practice — the defaults in hardware-flops.ts cover
// unidentifiable hardware — so this reflects the middle of the distribution.
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
