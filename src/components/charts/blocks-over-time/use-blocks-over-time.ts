import { useMemo } from "react";
import { useTelemetryStore } from "../../../store/telemetry-store";
import type { MinerCategory } from "../../../types/telemetry";

export interface BlocksOverTimeSeries {
  id: MinerCategory;
  data: Array<{ x: number; y: number }>;
}

export function useBlocksOverTime(): BlocksOverTimeSeries[] {
  const blocks = useTelemetryStore((s) => s.blocks);
  const selectedTypes = useTelemetryStore((s) => s.selectedTypes);

  return useMemo(() => {
    const filtered = blocks.filter((b) => selectedTypes.includes(b.minerCategory));
    if (filtered.length === 0) return [];

    const minTimestamp = filtered[0]!.timestamp;
    const grouped: Record<string, Array<{ x: number; y: number }>> = {};

    for (const type of selectedTypes) {
      grouped[type] = [];
    }

    const counts: Record<string, number> = {};
    for (const type of selectedTypes) {
      counts[type] = 0;
    }

    for (const block of filtered) {
      counts[block.minerCategory] = (counts[block.minerCategory] ?? 0) + 1;
      grouped[block.minerCategory]!.push({
        x: Math.round((block.timestamp - minTimestamp) / 60),
        y: counts[block.minerCategory]!,
      });
    }

    return selectedTypes
      .filter((type) => (grouped[type]?.length ?? 0) > 0)
      .map((type) => ({
        id: type,
        data: grouped[type]!,
      }));
  }, [blocks, selectedTypes]);
}
