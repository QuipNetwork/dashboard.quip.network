// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { buildMinerCategoryIndex, categoryFor } from "../../../lib/miner-category";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useFilteredBlocks } from "../../../store/use-filtered-blocks";
import { useUIStore } from "../../../store/ui-store";

export interface ComputeUsedEntry {
  [key: string]: string | number;
  minerType: string;
  compute: number;
}

/**
 * "Compute used" was originally `miningTime × unitCount`, where unitCount
 * came from the per-node hardware snapshot (CPUs/GPUs/QPUs). v0.3 drops
 * that snapshot — until hardware inventory returns via peer-query, this
 * chart degrades to raw `miningTime` accumulation (unit count = 1).
 */
export function useComputeUsed(): ComputeUsedEntry[] {
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const catIndex = buildMinerCategoryIndex(chainMiners);
    const totals: Record<string, number> = {};
    const getKey = (b: (typeof blocks)[0]) =>
      mode === "byType" ? categoryFor(b.minerId, catIndex) : b.minerId;

    for (const block of blocks) {
      const key = getKey(block);
      if (mode === "byType" && !selectedTypes.includes(categoryFor(block.minerId, catIndex)))
        continue;
      totals[key] = (totals[key] ?? 0) + block.miningTime;
    }

    const keys = mode === "byType" ? [...selectedTypes] : Object.keys(totals);
    return keys
      .filter((k) => totals[k] !== undefined)
      .map((k) => ({ minerType: k, compute: totals[k]! }));
  }, [blocks, chainMiners, selectedTypes, mode]);
}
