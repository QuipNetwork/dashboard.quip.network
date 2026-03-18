import { useMemo } from "react";
import { useTelemetryStore } from "../../../store/telemetry-store";
import type { MinerCategory } from "../../../types/telemetry";

export interface MiningTimeByDifficultySeries {
  id: MinerCategory;
  data: Array<{ x: number; y: number }>;
}

export interface MiningTimeByDifficultyResult {
  series: MiningTimeByDifficultySeries[];
  xMin: number;
  xMax: number;
}

const NUM_BANDS = 12;

export function useMiningTimeByDifficulty(): MiningTimeByDifficultyResult {
  const blocks = useTelemetryStore((s) => s.blocks);
  const selectedTypes = useTelemetryStore((s) => s.selectedTypes);

  return useMemo(() => {
    // Exclude blocks with miningTime=0 (unreported)
    const filtered = blocks.filter(
      (b) => selectedTypes.includes(b.minerCategory) && b.miningTime > 0,
    );
    if (filtered.length === 0) return { series: [], xMin: 0, xMax: 0 };

    const sorted = [...filtered].sort((a, b) => a.difficultyEnergy - b.difficultyEnergy);

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

    const series: Partial<Record<MinerCategory, Array<{ x: number; y: number }>>> = {};
    for (const type of selectedTypes) {
      series[type] = [];
    }

    for (let i = 0; i < cleaned.length; i += bandSize) {
      const band = cleaned.slice(i, Math.min(i + bandSize, cleaned.length));
      if (band.length === 0) continue;

      const midpoint = Math.round(
        band.reduce((sum, b) => sum + b.difficultyEnergy, 0) / band.length,
      );

      // Compute mean mining time per type within this band
      const sums: Partial<Record<MinerCategory, number>> = {};
      const counts: Partial<Record<MinerCategory, number>> = {};

      for (const b of band) {
        sums[b.minerCategory] = (sums[b.minerCategory] ?? 0) + b.miningTime;
        counts[b.minerCategory] = (counts[b.minerCategory] ?? 0) + 1;
      }

      for (const type of selectedTypes) {
        const count = counts[type] ?? 0;
        if (count > 0) {
          series[type]!.push({
            x: midpoint,
            y: Math.round(sums[type]! / count),
          });
        }
      }
    }

    const result = selectedTypes
      .filter((type) => series[type]!.length > 0)
      .map((type) => ({
        id: type,
        data: series[type]!,
      }));

    const xMin = cleaned[0]!.difficultyEnergy;
    const xMax = cleaned[cleaned.length - 1]!.difficultyEnergy;

    return { series: result, xMin: Math.floor(xMin), xMax: Math.ceil(xMax) };
  }, [blocks, selectedTypes]);
}
