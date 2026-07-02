// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { clipToDifficultyFloor } from "@/lib/difficulty-curve";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useFilteredBlocks } from "@/store/use-filtered-blocks";
import { useUIStore } from "@/store/ui-store";

export interface WinRateSeries {
  id: string;
  data: Array<{ x: number; y: number }>;
}

export interface WinRateByDifficultyResult {
  series: WinRateSeries[];
  xMin: number;
  xMax: number;
}

const NUM_BANDS = 12;

export function useWinRateByDifficulty(): WinRateByDifficultyResult {
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const selectedTypes = useUIStore((s) => s.selectedTypes);

  return useMemo(() => {
    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
    const filtered = blocks.filter((b) => selectedTypes.includes(categoryFor(b.minerId, catIndex)));
    if (filtered.length === 0) return { series: [], xMin: 0, xMax: 0 };

    // Start the axis where real data is: drop easy warmup targets before banding.
    const inRegime = clipToDifficultyFloor(filtered);
    const sorted = [...inRegime].sort((a, b) => a.difficultyEnergy - b.difficultyEnergy);

    // Remove outliers via IQR so extreme values don't blow up the x-axis
    const q1 = sorted[Math.floor(sorted.length * 0.25)]!.difficultyEnergy;
    const q3 = sorted[Math.floor(sorted.length * 0.75)]!.difficultyEnergy;
    const iqr = q3 - q1;
    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;
    const cleaned = sorted.filter(
      (b) => b.difficultyEnergy >= lower && b.difficultyEnergy <= upper,
    );
    if (cleaned.length === 0) return { series: [], xMin: 0, xMax: 0 };

    const bandSize = Math.max(1, Math.floor(cleaned.length / NUM_BANDS));

    const series: Record<string, Array<{ x: number; y: number }>> = {};
    for (const type of selectedTypes) {
      series[type] = [];
    }

    for (let i = 0; i < cleaned.length; i += bandSize) {
      const band = cleaned.slice(i, Math.min(i + bandSize, cleaned.length));
      if (band.length === 0) continue;

      // Band midpoint (average difficulty)
      const midpoint = Math.round(
        band.reduce((sum, b) => sum + b.difficultyEnergy, 0) / band.length,
      );

      // Count wins per type
      const wins: Record<string, number> = {};
      for (const b of band) {
        const cat = categoryFor(b.minerId, catIndex);
        wins[cat] = (wins[cat] ?? 0) + 1;
      }

      for (const type of selectedTypes) {
        const rate = ((wins[type] ?? 0) / band.length) * 100;
        series[type]!.push({
          x: midpoint,
          y: Math.round(rate * 10) / 10,
        });
      }
    }

    const result = selectedTypes
      .filter((type) => series[type]!.some((d) => d.y > 0))
      .map((type) => ({
        id: type,
        data: series[type]!,
      }));

    const xMin = cleaned[0]!.difficultyEnergy;
    const xMax = cleaned[cleaned.length - 1]!.difficultyEnergy;

    return { series: result, xMin: Math.floor(xMin), xMax: Math.ceil(xMax) };
  }, [blocks, chainMiners, nodeDescriptors, selectedTypes]);
}
