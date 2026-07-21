// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MinerCategory, NodeDescriptorRecord, NodeMinerEntry } from "@quip/shared/telemetry";
import type { BlocksOverTimeSeries } from "./use-blocks-over-time";

/** Registered-device counts per category, keyed like `useBlocksOverTime`'s byType series ids. */
export type DeviceCounts = Record<MinerCategory, number>;

/**
 * Count registered devices per miner category from published node
 * descriptors — the denominator for the "Normalized" per-device qblock
 * rate (nextsteps.md #9: "per count of device type, not per miner type,
 * so a miner with 6 CPU adds 6 to the CPU total").
 *
 * Counting rule per `NodeMinerEntry`:
 *   - CPU: `numCpus ?? 1` — the entry's core count is the device count.
 *   - GPU: 1 per GPU-kind entry. `NodeMinerEntry.deviceIndex` exists on
 *     the type but no current producer populates it, and
 *     `systemInfo.gpus.length` would need a descriptor→node join this
 *     helper doesn't have inputs for. `src/testing/sample-telemetry.ts`
 *     mints one GPU `NodeMinerEntry` per physical GPU (its 2-GPU fixture
 *     gets two GPU entries, its 1-GPU fixture one) — matching the process
 *     model of one miner process per device — so counting GPU-kind
 *     entries directly already equals device count.
 *   - QPU: 1 per entry — a QPU entry is one provider/solver access slot.
 *   - OTHER: 1 per entry, for symmetry (not currently a `kind` any
 *     producer emits, but the switch stays exhaustive).
 *
 * Descriptor-less or miners-less nodes contribute nothing.
 */
export function countDevicesByType(nodeDescriptors: readonly NodeDescriptorRecord[]): DeviceCounts {
  const counts: DeviceCounts = { CPU: 0, GPU: 0, QPU: 0, OTHER: 0 };
  for (const record of nodeDescriptors) {
    const miners = record.descriptor.miners;
    if (!miners) continue;
    for (const entry of Object.values(miners)) {
      counts[entry.kind] += deviceCountForEntry(entry);
    }
  }
  return counts;
}

function deviceCountForEntry(entry: NodeMinerEntry): number {
  switch (entry.kind) {
    case "CPU":
      return entry.numCpus ?? 1;
    case "GPU":
    case "QPU":
    case "OTHER":
      return 1;
  }
}

/**
 * Divide each byType series' cumulative counts by its registered-device
 * count. A type with zero registered devices is omitted entirely rather
 * than divided by zero, so the output never carries NaN/Infinity.
 */
export function normalizeSeriesByDeviceCount(
  series: readonly BlocksOverTimeSeries[],
  counts: DeviceCounts,
): BlocksOverTimeSeries[] {
  const normalized: BlocksOverTimeSeries[] = [];
  for (const s of series) {
    const count = counts[s.id as MinerCategory] ?? 0;
    if (count <= 0) continue;
    normalized.push({ id: s.id, data: s.data.map((p) => ({ x: p.x, y: p.y / count })) });
  }
  return normalized;
}
