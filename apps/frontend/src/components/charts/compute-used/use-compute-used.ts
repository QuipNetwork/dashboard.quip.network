// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useFilteredBlocks } from "@/store/use-filtered-blocks";
import { useUIStore } from "@/store/ui-store";

export interface ComputeUsedEntry {
  [key: string]: string | number;
  minerType: string;
  compute: number;
}

/**
 * Total compute accounted for, in seconds, grouped by `aggregationMode`.
 *
 * Two source paths, picked per block by the *winning miner's* category:
 *
 *   - CPU/GPU blocks → `block.miningTime` (reported device compute time on
 *     spec-111+ wins; derived block spacing — wall-clock seconds between
 *     winner blocks — as fallback for pre-111/unreported wins).
 *     Originally meant to be multiplied by parallel worker count, but
 *     the v0.3 hardware-snapshot drop took unitCount with it — for now
 *     this is the reported (or derived) time directly.
 *
 *   - QPU blocks → sum of `qpuAccessTimeUs` from the matching
 *     mining_submissions row (joined by `chainBlockNumber`). Captures
 *     the actual D-Wave annealing+readout time. Wall-clock is
 *     unusable for QPU because D-Wave cloud RTT dominates it by 100x+.
 *
 * QPU blocks without a matching local mining_submissions row (i.e.
 * other operators' QPU wins, where the indexer has no iteration data)
 * are *omitted* from the QPU aggregation rather than counted with
 * wall-clock as a fallback — undercounting beats overcounting by an
 * order of magnitude. Self-QPU operators see accurate numbers; the
 * network-wide QPU bar accurately reflects every QPU miner whose
 * dashboard is the source of truth.
 */
export function useComputeUsed(): ComputeUsedEntry[] {
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const recentMiningSubmissions = useTelemetryStore((s) => s.recentMiningSubmissions);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
    // Map from chain_block_number → sum of qpu_access_time in seconds.
    // Only populated for submissions the local indexer has seen
    // (self-only today); other QPU miners contribute nothing and are
    // excluded from the QPU bar.
    const qpuSecondsByBlock = new Map<string, number>();
    for (const s of recentMiningSubmissions) {
      if (s.chainBlockNumber == null) continue;
      if (s.qpuAccessTimeUs <= 0) continue;
      qpuSecondsByBlock.set(s.chainBlockNumber, s.qpuAccessTimeUs / 1_000_000);
    }
    const totals: Record<string, number> = {};
    const getKey = (b: (typeof blocks)[0]) =>
      mode === "byType" ? categoryFor(b.minerId, catIndex) : b.minerId;

    for (const block of blocks) {
      const category = categoryFor(block.minerId, catIndex);
      if (mode === "byType" && !selectedTypes.includes(category)) continue;
      let contribution: number;
      if (category === "QPU") {
        const qpuSec = qpuSecondsByBlock.get(block.substrateBlockNumber);
        if (qpuSec == null) continue; // Skip: no local data for this QPU block.
        contribution = qpuSec;
      } else {
        contribution = block.miningTime;
      }
      const key = getKey(block);
      totals[key] = (totals[key] ?? 0) + contribution;
    }

    const keys = mode === "byType" ? [...selectedTypes] : Object.keys(totals);
    return keys
      .filter((k) => totals[k] !== undefined)
      .map((k) => ({ minerType: k, compute: totals[k]! }));
  }, [blocks, chainMiners, nodeDescriptors, recentMiningSubmissions, selectedTypes, mode]);
}
