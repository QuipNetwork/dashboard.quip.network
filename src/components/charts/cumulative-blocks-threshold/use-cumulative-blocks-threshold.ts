import { useMemo } from "react";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useUIStore } from "../../../store/ui-store";
import { getUnitCount } from "../../../lib/units";

export interface CumulativeBlocksThresholdSeries {
  id: string;
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

    // Group blocks by key with their energy and unit count
    const byKey: Record<string, Array<{ energy: number; units: number }>> = {};
    const totalUnits: Record<string, number> = {};

    for (const b of cleaned) {
      const key = getKey(b);
      const units = getUnitCount(b);
      (byKey[key] ??= []).push({ energy: b.energy, units });
      totalUnits[key] = (totalUnits[key] ?? 0) + units;
    }

    const keys =
      mode === "byType"
        ? selectedTypes.filter((t) => byKey[t]?.length)
        : Object.keys(byKey);

    // Sort each key's blocks by energy
    for (const k of keys) {
      byKey[k]?.sort((a, b) => a.energy - b.energy);
    }

    // Generate threshold sweep
    const step = (max - min) / (NUM_POINTS - 1);
    const thresholds: number[] = [];
    for (let i = 0; i < NUM_POINTS; i++) {
      thresholds.push(min + i * step);
    }

    const series = keys.map((key) => {
      const entries = byKey[key]!;
      const units = totalUnits[key]!;

      return {
        id: key,
        data: thresholds.map((t) => {
          let count = 0;
          for (const entry of entries) {
            if (entry.energy <= t) count++;
            else break;
          }
          return {
            x: Math.round(t),
            y: Math.round((count / units) * 1000) / 1000,
          };
        }),
      };
    });

    return { series, xMin: Math.floor(min), xMax: Math.ceil(max) };
  }, [blocks, selectedTypes, mode]);
}
