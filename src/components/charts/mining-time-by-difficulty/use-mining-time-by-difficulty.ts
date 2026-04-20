import { useMemo } from "react";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useUIStore } from "../../../store/ui-store";

export interface MiningTimeByDifficultySeries {
  id: string;
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
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const filtered =
      mode === "byType"
        ? blocks.filter((b) => selectedTypes.includes(b.minerCategory) && b.miningTime > 0)
        : blocks.filter((b) => b.miningTime > 0);
    if (filtered.length === 0) return { series: [], xMin: 0, xMax: 0 };

    const getKey = (b: (typeof blocks)[0]) => (mode === "byType" ? b.minerCategory : b.minerId);

    const sorted = [...filtered].sort((a, b) => a.difficultyEnergy - b.difficultyEnergy);

    // Remove outliers via IQR
    const q1 = sorted[Math.floor(sorted.length * 0.25)]!.difficultyEnergy;
    const q3 = sorted[Math.floor(sorted.length * 0.75)]!.difficultyEnergy;
    const iqr = q3 - q1;
    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;
    const cleaned = sorted.filter(
      (b) => b.difficultyEnergy >= lower && b.difficultyEnergy <= upper,
    );
    if (cleaned.length === 0) return { series: [], xMin: 0, xMax: 0 };

    const allKeys = mode === "byType" ? [...selectedTypes] : [...new Set(cleaned.map(getKey))];

    const bandSize = Math.max(1, Math.floor(cleaned.length / NUM_BANDS));

    const series: Record<string, Array<{ x: number; y: number }>> = {};
    for (const k of allKeys) series[k] = [];

    for (let i = 0; i < cleaned.length; i += bandSize) {
      const band = cleaned.slice(i, Math.min(i + bandSize, cleaned.length));
      if (band.length === 0) continue;

      const midpoint = Math.round(
        band.reduce((sum, b) => sum + b.difficultyEnergy, 0) / band.length,
      );

      const sums: Record<string, number> = {};
      const counts: Record<string, number> = {};

      for (const b of band) {
        const key = getKey(b);
        sums[key] = (sums[key] ?? 0) + b.miningTime;
        counts[key] = (counts[key] ?? 0) + 1;
      }

      for (const k of allKeys) {
        const count = counts[k] ?? 0;
        if (count > 0) {
          series[k]!.push({ x: midpoint, y: Math.round(sums[k]! / count) });
        }
      }
    }

    const result = allKeys
      .filter((k) => series[k]!.length > 0)
      .map((k) => ({ id: k, data: series[k]! }));

    const xMin = cleaned[0]!.difficultyEnergy;
    const xMax = cleaned[cleaned.length - 1]!.difficultyEnergy;

    return { series: result, xMin: Math.floor(xMin), xMax: Math.ceil(xMax) };
  }, [blocks, selectedTypes, mode]);
}
