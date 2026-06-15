// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useFilteredBlocks } from "@/store/use-filtered-blocks";
import { useUIStore } from "@/store/ui-store";
import type { MinerCategory } from "@/types/telemetry";

export interface ActiveNodesEntry {
  [key: string]: string | number;
  minerType: MinerCategory;
  count: number;
}

export function useActiveNodes(): ActiveNodesEntry[] {
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const selectedTypes = useUIStore((s) => s.selectedTypes);

  return useMemo(() => {
    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
    // Initialise each selected bucket so the chart renders zero-count
    // categories rather than collapsing them.
    const miners: Record<string, Set<string>> = {};
    for (const type of selectedTypes) miners[type] = new Set();

    for (const block of blocks) {
      const cat = categoryFor(block.minerId, catIndex);
      miners[cat]?.add(block.minerId);
    }

    return selectedTypes.map((type) => ({
      minerType: type,
      count: miners[type]?.size ?? 0,
    }));
  }, [blocks, chainMiners, nodeDescriptors, selectedTypes]);
}
