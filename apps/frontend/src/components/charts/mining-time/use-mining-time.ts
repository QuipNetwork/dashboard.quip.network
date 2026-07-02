// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useFilteredBlocks } from "@/store/use-filtered-blocks";
import { useUIStore } from "@/store/ui-store";

export interface MiningTimeSeries {
  id: string;
  data: Array<{ x: number; y: number }>;
}

// Only the most recent N qblocks are plotted. The x-axis is the raw
// `substrateBlockNumber`, so without a window a few low-numbered backfilled
// blocks stretch the domain to the whole chain and crush all real data into a
// sliver on the right. Windowing to the recent tail zooms the axis onto the
// span operators actually care about. Tunable.
export const RECENT_QBLOCK_WINDOW = 100;

export function useMiningTime(): MiningTimeSeries[] {
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
    const typeFiltered =
      mode === "byType"
        ? blocks.filter((b) => selectedTypes.includes(categoryFor(b.minerId, catIndex)))
        : blocks;
    // `blocks` ships DESC (tip first), so the most recent qblocks are the head
    // of the array. Slice before grouping so every series shares the same
    // recent block-number window.
    const filtered = typeFiltered.slice(0, RECENT_QBLOCK_WINDOW);
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
  }, [blocks, chainMiners, nodeDescriptors, selectedTypes, mode]);
}
