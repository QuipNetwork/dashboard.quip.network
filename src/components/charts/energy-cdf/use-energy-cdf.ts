import { useMemo } from "react";
import { useTelemetryStore } from "../../../store/telemetry-store";
import type { MinerCategory } from "../../../types/telemetry";

export interface EnergyCdfSeries {
  id: MinerCategory;
  data: Array<{ x: number; y: number }>;
}

export interface EnergyCdfResult {
  series: EnergyCdfSeries[];
  xMin: number;
  xMax: number;
}

const NUM_POINTS = 50;

export function useEnergyCdf(): EnergyCdfResult {
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

    // Group energies by miner type
    const byType: Partial<Record<MinerCategory, number[]>> = {};
    for (const b of cleaned) {
      (byType[b.minerCategory] ??= []).push(b.energy);
    }

    // Generate threshold sweep points
    const step = (max - min) / (NUM_POINTS - 1);
    const thresholds: number[] = [];
    for (let i = 0; i < NUM_POINTS; i++) {
      thresholds.push(min + i * step);
    }

    const series = selectedTypes
      .filter((type) => byType[type] && byType[type]!.length > 0)
      .map((type) => {
        const energies = byType[type]!;
        const sorted = [...energies].sort((a, b) => a - b);
        const total = sorted.length;

        return {
          id: type,
          data: thresholds.map((t) => {
            // Binary search for count of energies <= t
            let lo = 0;
            let hi = total;
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              if (sorted[mid]! <= t) lo = mid + 1;
              else hi = mid;
            }
            return {
              x: Math.round(t),
              y: Math.round((lo / total) * 1000) / 10, // percentage
            };
          }),
        };
      });

    return { series, xMin: Math.floor(min), xMax: Math.ceil(max) };
  }, [blocks, selectedTypes]);
}
