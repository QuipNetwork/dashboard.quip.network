// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useFilteredBlocks } from "@/store/use-filtered-blocks";
import { useUIStore } from "@/store/ui-store";
import { buildHistogram, type HistogramData } from "@/lib/histogram";

// Keep blocks won within this fraction of the hardest difficulty target seen in
// the window; everything easier (the warmup that kicks off mining) drops out.
const HARD_TARGET_BAND = 0.02; // 2% of the hardest (most-negative) target energy

// Restrict to the current hard mining regime. A block's `difficultyEnergy` is
// the target it cleared; keep only those near the hardest target observed.
// Falls back to all blocks when there are no usable targets or the clip would
// empty the chart.
function clipToHardRegime<T extends { difficultyEnergy: number }>(blocks: T[]): T[] {
  const targets = blocks.map((b) => b.difficultyEnergy).filter((d) => d < 0);
  if (targets.length === 0) return blocks;
  const hardest = Math.min(...targets); // most negative = hardest
  const cutoff = hardest + Math.abs(hardest) * HARD_TARGET_BAND;
  const clipped = blocks.filter((b) => b.difficultyEnergy <= cutoff);
  return clipped.length > 0 ? clipped : blocks;
}

/**
 * v0.3 transitional: per-block unit counts came from the v0.2 `nodes`
 * snapshot, which no longer exists. Each block contributes a single
 * sample to the histogram (unitCount=1) until per-miner hardware lands
 * via peer-query.
 */
export function useEnergyDistribution(): HistogramData {
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
    const filtered =
      mode === "byType"
        ? blocks.filter((b) => selectedTypes.includes(categoryFor(b.minerId, catIndex)))
        : blocks;

    // Focus on the current hard regime: drop the "easy" blocks that kick off
    // mining while difficulty is still ramping up from its easy end. A block's
    // own `difficultyEnergy` is the target it was won against; keep only blocks
    // whose target is within HARD_TARGET_BAND of the hardest target observed in
    // the window. This concentrates the histogram (and its bins) on results
    // near the top of the hardness range. Tunable.
    const hard = clipToHardRegime(filtered);

    const values = hard.map((b) => ({
      value: b.energy,
      group: mode === "byType" ? categoryFor(b.minerId, catIndex) : b.minerId,
      unitCount: 1,
    }));

    const keys = mode === "byType" ? [...selectedTypes] : [...new Set(values.map((v) => v.group))];

    // More bins than the default heuristic — the range is now narrow (the hard
    // regime only), so finer bins resolve the distribution near the target.
    return buildHistogram(values, keys, { binCount: 12 });
  }, [blocks, chainMiners, nodeDescriptors, selectedTypes, mode]);
}
