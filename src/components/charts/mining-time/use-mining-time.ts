import { useMemo } from "react";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useUIStore } from "../../../store/ui-store";

export interface MiningTimeSeries {
  id: string;
  data: Array<{ x: number; y: number }>;
}

export function useMiningTime(): MiningTimeSeries[] {
  const blocks = useTelemetryStore((s) => s.blocks);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const filtered =
      mode === "byType"
        ? blocks.filter((b) => selectedTypes.includes(b.minerCategory))
        : blocks;
    const getKey = (b: (typeof blocks)[0]) =>
      mode === "byType" ? b.minerCategory : b.minerId;

    const grouped: Record<string, Array<{ x: number; y: number }>> = {};

    for (const block of filtered) {
      const key = getKey(block);
      (grouped[key] ??= []).push({ x: block.blockIndex, y: block.miningTime });
    }

    const keys = mode === "byType" ? [...selectedTypes] : Object.keys(grouped);
    return keys
      .filter((k) => grouped[k]?.length)
      .map((k) => ({ id: k, data: grouped[k]! }));
  }, [blocks, selectedTypes, mode]);
}
