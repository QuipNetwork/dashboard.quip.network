import { useMemo } from "react";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { getUnitCount } from "../../../lib/units";
import type { MinerCategory } from "../../../types/telemetry";

export interface CumulativeBlocksThresholdSeries {
  id: MinerCategory;
  data: Array<{ x: number; y: number }>;
}

export interface CumulativeBlocksThresholdResult {
  series: CumulativeBlocksThresholdSeries[];
  xMin: number;
  xMax: number;
}

const NUM_POINTS = 50;

export function useCumulativeBlocksThreshold(): CumulativeBlocksThresholdResult {
  const blocks = useTelemetryStore((s) => s.blocks);
  const selectedTypes = useTelemetryStore((s) => s.selectedTypes);

  return useMemo(() => {
    const filtered = blocks.filter((b) => selectedTypes.includes(b.minerCategory));
    if (filtered.length === 0) return { series: [], xMin: 0, xMax: 0 };

    // Sort energies and remove outliers via IQR
    const sortedEnergies = filtered.map((b) => b.energy).sort((a, b) => a - b);
    const q1 = sortedEnergies[Math.floor(sortedEnergies.length * 0.25)]!;
    const q3 = sortedEnergies[Math.floor(sortedEnergies.length * 0.75)]!;
    const iqr = q3 - q1;
    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;

    const cleaned = filtered.filter((b) => b.energy >= lower && b.energy <= upper);
    if (cleaned.length === 0) return { series: [], xMin: 0, xMax: 0 };

    const cleanedEnergies = cleaned.map((b) => b.energy);
    const min = Math.min(...cleanedEnergies);
    const max = Math.max(...cleanedEnergies);

    // Group blocks by type with their energy and unit count
    const byType: Partial<
      Record<MinerCategory, Array<{ energy: number; units: number }>>
    > = {};
    const totalUnits: Partial<Record<MinerCategory, number>> = {};

    for (const b of cleaned) {
      const units = getUnitCount(b);
      (byType[b.minerCategory] ??= []).push({ energy: b.energy, units });
      totalUnits[b.minerCategory] = (totalUnits[b.minerCategory] ?? 0) + units;
    }

    // Sort each type's blocks by energy
    for (const type of selectedTypes) {
      byType[type]?.sort((a, b) => a.energy - b.energy);
    }

    // Generate threshold sweep
    const step = (max - min) / (NUM_POINTS - 1);
    const thresholds: number[] = [];
    for (let i = 0; i < NUM_POINTS; i++) {
      thresholds.push(min + i * step);
    }

    const series = selectedTypes
      .filter((type) => byType[type] && byType[type]!.length > 0)
      .map((type) => {
        const entries = byType[type]!;
        const units = totalUnits[type]!;

        return {
          id: type,
          data: thresholds.map((t) => {
            // Count blocks meeting threshold, normalized by total units
            let count = 0;
            for (const entry of entries) {
              if (entry.energy <= t) count++;
              else break; // sorted, so we can stop
            }
            return {
              x: Math.round(t),
              y: Math.round((count / units) * 1000) / 1000,
            };
          }),
        };
      });

    return { series, xMin: Math.floor(min), xMax: Math.ceil(max) };
  }, [blocks, selectedTypes]);
}
