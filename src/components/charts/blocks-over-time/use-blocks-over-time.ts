// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { buildMinerCategoryIndex, categoryFor } from "../../../lib/miner-category";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useFilteredBlocks } from "../../../store/use-filtered-blocks";
import { useUIStore } from "../../../store/ui-store";

export interface BlocksOverTimeSeries {
  id: string;
  data: Array<{ x: number; y: number }>;
}

export function useBlocksOverTime(): BlocksOverTimeSeries[] {
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const catIndex = buildMinerCategoryIndex(chainMiners);
    const filtered =
      mode === "byType"
        ? blocks.filter((b) => selectedTypes.includes(categoryFor(b.minerId, catIndex)))
        : blocks;
    if (filtered.length === 0) return [];

    const minTimestamp = filtered[0]!.timestamp;
    const getKey = (b: (typeof blocks)[0]) =>
      mode === "byType" ? categoryFor(b.minerId, catIndex) : b.minerId;

    const keys = mode === "byType" ? [...selectedTypes] : [...new Set(filtered.map(getKey))];
    const grouped: Record<string, Array<{ x: number; y: number }>> = {};
    const counts: Record<string, number> = {};
    for (const k of keys) {
      grouped[k] = [];
      counts[k] = 0;
    }

    for (const block of filtered) {
      const key = getKey(block);
      counts[key] = (counts[key] ?? 0) + 1;
      (grouped[key] ??= []).push({
        x: Math.round((block.timestamp - minTimestamp) / 60),
        y: counts[key]!,
      });
    }

    return keys
      .filter((k) => (grouped[k]?.length ?? 0) > 0)
      .map((k) => ({ id: k, data: grouped[k]! }));
  }, [blocks, chainMiners, selectedTypes, mode]);
}
