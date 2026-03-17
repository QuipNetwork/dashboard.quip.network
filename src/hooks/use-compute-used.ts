import { useMemo } from "react";
import { useTelemetryStore } from "../store/telemetry-store";
import type { MinerCategory } from "../types/telemetry";

export interface ComputeUsedEntry {
  [key: string]: string | number;
  minerType: MinerCategory;
  compute: number;
}

function getUnitCount(block: {
  minerCategory: MinerCategory;
  minerConfig: { cpu: { num_cpus: number } | null; gpu: { devices: string[] } | null };
}): number {
  if (block.minerCategory === "GPU" && block.minerConfig.gpu)
    return block.minerConfig.gpu.devices.length;
  if (block.minerCategory === "CPU" && block.minerConfig.cpu) return block.minerConfig.cpu.num_cpus;
  return 1;
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
