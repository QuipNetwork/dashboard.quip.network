// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { estimateNodeFlops, lookupCpu, lookupGpu } from "@/lib/hardware-flops";
import { resolveServerNowMs, selectTipBlock, useTelemetryStore } from "@/store/telemetry-store";
import type { BlockRecord, NodeInfo } from "@quip/shared/telemetry";

// Window used to decide whether a node counts toward the "live" hardware
// inventory (locations, CPU/GPU/QPU totals, Est. PFLOPS, model breakdowns).
// A node that hasn't refreshed its on-chain descriptor in 14+ days is
// treated as gone dark rather than contributing capacity — see
// `isNodeActive`.
export const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Whether `node` has been seen recently enough to count toward the
 * network's "live" hardware inventory. `NodeInfo.lastSeen` is a Unix
 * *seconds* timestamp sourced from the most recent `MinerRegistry.
 * NodeDescriptors` block the node re-announced on (see
 * `apps/server/routes/telemetry.ts`'s `projectDescriptorsToSnapshot`); it
 * is NOT a heartbeat, so "active" here means "re-announced within the
 * window", not "currently online".
 */
export function isNodeActive(node: NodeInfo, nowMs: number): boolean {
  return nowMs - node.lastSeen * 1000 <= FOURTEEN_DAYS_MS;
}

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
  // Nodes last seen (re-announced their descriptor) within the last 14
  // days — see `isNodeActive`. totalCpus/totalGpus/totalQpus/
  // totalPetaflops/cpuModels/gpuModels/locatedNodes/unlocatedCount are all
  // scoped to this set; totalNodes above is NOT (it's the all-time count).
  activeNodeCount: number;
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
  // Subscribe to the stable `serverTime` string and resolve "now" inside the
  // memo — NOT via a store selector. `resolveServerNowMs` falls back to
  // `Date.now()` when serverTime is null, which returns a fresh number every
  // call; as a zustand selector that loops `useSyncExternalStore` (bead mrt).
  // The 14-day window anchor doesn't need to tick, so resolving it once here
  // keyed on the stable string is both correct and loop-safe.
  const serverTime = useTelemetryStore((s) => s.serverTime);

  return useMemo<ComputeAvailability>(() => {
    if (!nodes) return { ...EMPTY, lastBlock };

    const nowMs = resolveServerNowMs(serverTime);

    let activeNodeCount = 0;
    let totalCpus = 0;
    let totalGpus = 0;
    let totalQpus = 0;
    // All-time total across every known node — feeds the block-ceiling
    // PFLOP·s estimates below, which are about "the network" broadly and
    // are intentionally NOT windowed to the 14-day active set.
    let totalTflopsAll = 0;
    // 14-day-active total — feeds the "Est. PFLOPS" tile, which IS windowed
    // (see `isNodeActive`).
    let totalTflopsActive = 0;
    const cpuCounts = new Map<string, { count: number; tflops: number }>();
    const gpuCounts = new Map<string, { count: number; tflops: number }>();
    const perNode: PerNodeTflops[] = [];
    const located: LocatedNode[] = [];
    let unlocatedCount = 0;

    for (const node of Object.values(nodes.nodes)) {
      const flops = estimateNodeFlops(node);
      totalTflopsAll += flops.totalTflops;

      const displayName = node.nodeName ?? node.address.slice(0, 10);
      perNode.push({
        address: node.address,
        nodeName: displayName,
        tflops: flops.totalTflops,
      });

      // Everything below this line is windowed to nodes seen in the last 14
      // days — Node Locations, CPU/GPU/QPU totals, Est. PFLOPS, and the
      // CPU/GPU model breakdowns. A node that's gone dark shouldn't inflate
      // the "hardware currently available" picture even though it still
      // counts toward the all-time `totalNodes`/`perNodeTflops` above.
      if (!isNodeActive(node, nowMs)) continue;

      activeNodeCount++;
      totalCpus += countCpus(node);
      totalGpus += node.systemInfo?.gpus?.length ?? 0;
      totalQpus += countQpus(node);
      totalTflopsActive += flops.totalTflops;

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
      lastBlockWallClock != null ? (totalTflopsAll * lastBlockWallClock) / 1000 : null;
    const currentBlockElapsedSeconds =
      lastBlock != null ? Math.max(0, Date.now() / 1000 - lastBlock.timestamp) : null;
    const currentBlockPflopSeconds =
      currentBlockElapsedSeconds != null
        ? (totalTflopsAll * currentBlockElapsedSeconds) / 1000
        : null;

    return {
      totalNodes: Object.keys(nodes.nodes).length,
      activeNodeCount,
      totalCpus,
      totalGpus,
      totalQpus,
      totalPetaflops: totalTflopsActive / 1000,
      cpuModels: toBreakdown(cpuCounts),
      gpuModels: toBreakdown(gpuCounts),
      perNodeTflops: perNode,
      topNode: perNode[0] ?? null,
      medianNodeTflops: median(perNode.map((n) => n.tflops)),
      networkTflops: totalTflopsAll,
      lastBlock,
      lastBlockPflopSeconds,
      currentBlockPflopSeconds,
      currentBlockElapsedSeconds,
      locatedNodes: located,
      unlocatedCount,
    };
  }, [nodes, lastBlock, blocks, serverTime]);
}

const EMPTY: ComputeAvailability = {
  totalNodes: 0,
  activeNodeCount: 0,
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
