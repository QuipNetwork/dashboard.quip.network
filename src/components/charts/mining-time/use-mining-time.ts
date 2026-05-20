// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { buildMinerCategoryIndex, categoryFor } from "../../../lib/miner-category";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useFilteredBlocks } from "../../../store/use-filtered-blocks";
import { useUIStore } from "../../../store/ui-store";

export interface MiningTimeSeries {
  id: string;
  data: Array<{ x: number; y: number }>;
}

export function useMiningTime(): MiningTimeSeries[] {
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
    const getKey = (b: (typeof blocks)[0]) =>
      mode === "byType" ? categoryFor(b.minerId, catIndex) : b.minerId;

    const grouped: Record<string, Array<{ x: number; y: number }>> = {};

    for (const block of filtered) {
      const key = getKey(block);
      // x-axis was the v0.2 blockIndex; in v0.3 we use substrateBlockNumber.
      // Number() at the boundary — store ships as string for u64 safety.
      (grouped[key] ??= []).push({
        x: Number(block.substrateBlockNumber),
        y: block.miningTime,
      });
    }

    const keys = mode === "byType" ? [...selectedTypes] : Object.keys(grouped);
    return keys.filter((k) => grouped[k]?.length).map((k) => ({ id: k, data: grouped[k]! }));
  }, [blocks, chainMiners, selectedTypes, mode]);
}
