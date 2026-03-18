import { useMemo } from "react";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useUIStore } from "../../../store/ui-store";

export interface EnergyCdfSeries {
  id: string;
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
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const filtered =
      mode === "byType"
        ? blocks.filter((b) => selectedTypes.includes(b.minerCategory))
        : blocks;
    if (filtered.length === 0) return { series: [], xMin: 0, xMax: 0 };

    const getKey = (b: (typeof blocks)[0]) =>
      mode === "byType" ? b.minerCategory : b.minerId;

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

    // Group energies by key
    const byKey: Record<string, number[]> = {};
    for (const b of cleaned) {
      (byKey[getKey(b)] ??= []).push(b.energy);
    }

    // Generate threshold sweep points
    const step = (max - min) / (NUM_POINTS - 1);
    const thresholds: number[] = [];
    for (let i = 0; i < NUM_POINTS; i++) {
      thresholds.push(min + i * step);
    }

    const keys =
      mode === "byType"
        ? selectedTypes.filter((t) => byKey[t]?.length)
        : Object.keys(byKey);

    const series = keys.map((key) => {
      const energies = byKey[key]!;
      const sorted = [...energies].sort((a, b) => a - b);
      const total = sorted.length;

      return {
        id: key,
        data: thresholds.map((t) => {
          let lo = 0;
          let hi = total;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (sorted[mid]! <= t) lo = mid + 1;
            else hi = mid;
          }
          return {
            x: Math.round(t),
            y: Math.round((lo / total) * 1000) / 10,
          };
        }),
      };
    });

    return { series, xMin: Math.floor(min), xMax: Math.ceil(max) };
  }, [blocks, selectedTypes, mode]);
}
