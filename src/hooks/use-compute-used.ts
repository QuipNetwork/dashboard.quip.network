import { useMemo } from "react";
import { useTelemetryStore } from "../store/telemetry-store";
import { getUnitCount } from "../lib/units";
import type { MinerCategory } from "../types/telemetry";

export interface ComputeUsedEntry {
  [key: string]: string | number;
  minerType: MinerCategory;
  compute: number;
}

export function useComputeUsed(): ComputeUsedEntry[] {
  const blocks = useTelemetryStore((s) => s.blocks);
  const selectedTypes = useTelemetryStore((s) => s.selectedTypes);

  return useMemo(() => {
    const totals: Partial<Record<MinerCategory, number>> = {};

    for (const block of blocks) {
      if (!selectedTypes.includes(block.minerCategory)) continue;
      const units = getUnitCount(block);
      totals[block.minerCategory] = (totals[block.minerCategory] ?? 0) + block.miningTime * units;
    }

    return selectedTypes
      .filter((type) => totals[type] !== undefined)
      .map((type) => ({
        minerType: type,
        compute: totals[type]!,
      }));
  }, [blocks, selectedTypes]);
}
