import { useMemo } from "react";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useUIStore } from "../../../store/ui-store";
import { buildUnitCountIndex, getUnitCount } from "../../../lib/units";

export interface ComputeUsedEntry {
  [key: string]: string | number;
  minerType: string;
  compute: number;
}

export function useComputeUsed(): ComputeUsedEntry[] {
  const blocks = useTelemetryStore((s) => s.blocks);
  const nodes = useTelemetryStore((s) => s.nodes);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const unitIndex = buildUnitCountIndex(nodes);
    const totals: Record<string, number> = {};
    const getKey = (b: (typeof blocks)[0]) => (mode === "byType" ? b.minerCategory : b.minerId);

    for (const block of blocks) {
      if (mode === "byType" && !selectedTypes.includes(block.minerCategory)) continue;
      const key = getKey(block);
      const units = getUnitCount(block, unitIndex);
      totals[key] = (totals[key] ?? 0) + block.miningTime * units;
    }

    const keys = mode === "byType" ? [...selectedTypes] : Object.keys(totals);
    return keys
      .filter((k) => totals[k] !== undefined)
      .map((k) => ({ minerType: k, compute: totals[k]! }));
  }, [blocks, nodes, selectedTypes, mode]);
}
