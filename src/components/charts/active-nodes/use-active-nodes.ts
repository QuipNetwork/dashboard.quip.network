import { useMemo } from "react";
import { useFilteredBlocks } from "../../../store/use-filtered-blocks";
import { useUIStore } from "../../../store/ui-store";
import type { MinerCategory } from "../../../types/telemetry";

export interface ActiveNodesEntry {
  [key: string]: string | number;
  minerType: MinerCategory;
  count: number;
}

export function useActiveNodes(): ActiveNodesEntry[] {
  const blocks = useFilteredBlocks();
  const selectedTypes = useUIStore((s) => s.selectedTypes);

  return useMemo(() => {
    const miners: Record<MinerCategory, Set<string>> = {
      CPU: new Set(),
      GPU: new Set(),
      QPU: new Set(),
    };

    for (const block of blocks) {
      miners[block.minerCategory].add(block.minerId);
    }

    return selectedTypes.map((type) => ({
      minerType: type,
      count: miners[type].size,
    }));
  }, [blocks, selectedTypes]);
}
