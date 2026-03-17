import { useMemo } from "react";
import { useTelemetryStore } from "../store/telemetry-store";
import type { MinerCategory } from "../types/telemetry";

export interface MiningTimeSeries {
  id: MinerCategory;
  data: Array<{ x: number; y: number }>;
}

export function useMiningTime(): MiningTimeSeries[] {
  const blocks = useTelemetryStore((s) => s.blocks);
  const selectedTypes = useTelemetryStore((s) => s.selectedTypes);

  return useMemo(() => {
    const filtered = blocks.filter((b) => selectedTypes.includes(b.minerCategory));
    const grouped: Partial<Record<MinerCategory, Array<{ x: number; y: number }>>> = {};

    for (const block of filtered) {
      const arr = grouped[block.minerCategory] ??= [];
      arr.push({ x: block.blockIndex, y: block.miningTime });
    }

    return selectedTypes
      .filter((type) => grouped[type]?.length)
      .map((type) => ({
        id: type,
        data: grouped[type]!,
      }));
  }, [blocks, selectedTypes]);
}
