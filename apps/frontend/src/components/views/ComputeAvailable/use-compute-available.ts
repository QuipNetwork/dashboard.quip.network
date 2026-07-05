// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { estimateNodeFlops, lookupCpu, lookupGpu } from "@/lib/hardware-flops";
import { selectTipBlock, useTelemetryStore } from "@/store/telemetry-store";
import type { BlockRecord, NodeInfo } from "@quip/shared/telemetry";

export interface ModelBreakdown {
  model: string;
  count: number;
  tflops: number;
}

export interface PerNodeTflops {
  address: string;
  nodeName: string;
  tflops: number;
}

/**
 * A geo-located node ready for the world map. Subset of NodeInfo +
 * estimated TFLOPS so the map can size each marker by compute share.
 * Only nodes whose `publicHost` resolved to a lat/lng end up here;
 * unresolved nodes feed `unlocatedCount` instead.
 */
export interface LocatedNode {
  address: string;
  nodeName: string;
  country: string;
  city?: string;
  lat: number;
  lng: number;
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
  perNodeTflops: PerNodeTflops[]; // sorted desc by tflops
  topNode: PerNodeTflops | null;
  medianNodeTflops: number;
  // Sum of theoretical FP32 TFLOPS across every node in the snapshot.
  // Exposed so the block-ceiling tiles can multiply by mining time.
  networkTflops: number;
  // Block the network just completed (tip of chain). Null before first sync.
  lastBlock: BlockRecord | null;
  // PFLOP·s poured into the last block (networkTflops × wall-clock block
  // spacing / 1000). Uses timestamp delta between the two most recent winner
  // blocks — NOT miningTime, which on spec-112+ carries device compute time
  // (e.g. ~60ms for QPU) rather than wall-clock block duration. Null when
  // fewer than two blocks are available.
  lastBlockPflopSeconds: number | null;
  // PFLOP·s poured into the block currently being mined, based on wall-clock
  // elapsed since the last tip. Null when there is no tip block. This value
  // refreshes on each poll cycle (not every second) — it is labeled "and
  // counting" in the UI to make that cadence explicit.
  currentBlockPflopSeconds: number | null;
  // Seconds elapsed since the last tip block closed — companion to
  // currentBlockPflopSeconds so the UI can render both.
  currentBlockElapsedSeconds: number | null;
  // Nodes the server's geo-IP enricher resolved into a lat/lng marker.
  // Ordered by tflops desc so the world map's z-stack draws the biggest
  // markers last (most visible).
  locatedNodes: LocatedNode[];
  // Count of nodes with a `publicHost` that didn't geo-resolve. Drives the
  // map's "N nodes unlocated" footer so the operator can see the gap.
  unlocatedCount: number;
}

export function useComputeAvailable(): ComputeAvailability {
  const nodes = useTelemetryStore((s) => s.nodes);
  const lastBlock = useTelemetryStore(selectTipBlock);
  const blocks = useTelemetryStore((s) => s.blocks);

  return useMemo<ComputeAvailability>(() => {
    if (!nodes) return { ...EMPTY, lastBlock };

    let totalCpus = 0;
    let totalGpus = 0;
    let totalQpus = 0;
    let totalTflops = 0;
    const cpuCounts = new Map<string, { count: number; tflops: number }>();
    const gpuCounts = new Map<string, { count: number; tflops: number }>();
    const perNode: PerNodeTflops[] = [];
    const located: LocatedNode[] = [];
    let unlocatedCount = 0;

    for (const node of Object.values(nodes.nodes)) {
      totalCpus += countCpus(node);
      totalGpus += node.systemInfo?.gpus?.length ?? 0;
      totalQpus += countQpus(node);

      const flops = estimateNodeFlops(node);
      totalTflops += flops.totalTflops;

      const displayName = node.nodeName ?? node.address.slice(0, 10);
      perNode.push({
        address: node.address,
        nodeName: displayName,
        tflops: flops.totalTflops,
      });

      if (node.location) {
        located.push({
          address: node.address,
          nodeName: displayName,
          country: node.location.country,
          city: node.location.city,
          lat: node.location.lat,
          lng: node.location.lng,
          tflops: flops.totalTflops,
        });
      } else if (node.publicHost) {
        // publicHost was set but the geo-IP enricher returned no record —
        // count it toward the "unlocated" tally so the map's footer
        // explains the gap. Nodes without publicHost don't contribute
        // (they had nothing to resolve, so the gap isn't operationally
        // interesting).
        unlocatedCount++;
      }

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
    }

    perNode.sort((a, b) => b.tflops - a.tflops);
    // Sort located so the largest markers draw last (on top).
    located.sort((a, b) => a.tflops - b.tflops);

    // Block-ceiling estimates. "PFLOP-seconds" = TFLOPS × seconds ÷ 1000.
    // Interprets the network running at full theoretical FP32 throughput for
    // the block's duration — a ceiling, not a measurement.
    //
    // lastBlockWallClock: derive from timestamp delta between the two most
    // recent winner blocks instead of miningTime. miningTime now carries the
    // winner's self-reported device compute time on spec-112+ wins (e.g. ~60ms
    // for a QPU), which would collapse the PFLOP·s tile ~1000×. Wall-clock
    // block spacing (tip.timestamp − prev.timestamp) is always valid for this
    // "how long did the network run at full throughput" metric.
    const prevBlock: BlockRecord | undefined = blocks[1];
    const lastBlockWallClock =
      lastBlock != null && prevBlock != null
        ? Math.max(0, lastBlock.timestamp - prevBlock.timestamp)
        : null;
    // When there is only one block, we cannot derive a delta — show null so
    // the tile renders "—" rather than a meaningless value.
    const lastBlockPflopSeconds =
      lastBlockWallClock != null ? (totalTflops * lastBlockWallClock) / 1000 : null;
    const currentBlockElapsedSeconds =
      lastBlock != null ? Math.max(0, Date.now() / 1000 - lastBlock.timestamp) : null;
    const currentBlockPflopSeconds =
      currentBlockElapsedSeconds != null ? (totalTflops * currentBlockElapsedSeconds) / 1000 : null;

    return {
      totalNodes: Object.keys(nodes.nodes).length,
      totalCpus,
      totalGpus,
      totalQpus,
      totalPetaflops: totalTflops / 1000,
      cpuModels: toBreakdown(cpuCounts),
      gpuModels: toBreakdown(gpuCounts),
      perNodeTflops: perNode,
      topNode: perNode[0] ?? null,
      medianNodeTflops: median(perNode.map((n) => n.tflops)),
      networkTflops: totalTflops,
      lastBlock,
      lastBlockPflopSeconds,
      currentBlockPflopSeconds,
      currentBlockElapsedSeconds,
      locatedNodes: located,
      unlocatedCount,
    };
  }, [nodes, lastBlock, blocks]);
}

const EMPTY: ComputeAvailability = {
  totalNodes: 0,
  totalCpus: 0,
  totalGpus: 0,
  totalQpus: 0,
  totalPetaflops: 0,
  cpuModels: [],
  gpuModels: [],
  perNodeTflops: [],
  topNode: null,
  medianNodeTflops: 0,
  networkTflops: 0,
  lastBlock: null,
  lastBlockPflopSeconds: null,
  currentBlockPflopSeconds: null,
  currentBlockElapsedSeconds: null,
  locatedNodes: [],
  unlocatedCount: 0,
};

export function countCpus(node: NodeInfo): number {
  // Prefer the operator-declared CPU utilization (chain-signed
  // `miners.cpu.numCpus`) — it reflects what the miner actually uses, not the
  // container's kernel view of host capacity (a `num_cpus=1` miner on a
  // 16-core box should count as 1, not 16). On the live chain, though, miner
  // entries frequently omit `numCpus`; when a node has CPU-kind miner(s) but
  // none declare a count, fall back to `systemInfo.cpu.logicalCores` so the
  // "Total CPUs" tile reflects real capacity instead of 0. A node with no CPU
  // miner at all still contributes zero.
  let sum = 0;
  let hasCpuMiner = false;
  for (const m of Object.values(node.miners ?? {})) {
    if (m.kind !== "CPU") continue;
    hasCpuMiner = true;
    if (typeof m.numCpus === "number") sum += m.numCpus;
  }
  if (hasCpuMiner && sum === 0) return node.systemInfo?.cpu?.logicalCores ?? 0;
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
