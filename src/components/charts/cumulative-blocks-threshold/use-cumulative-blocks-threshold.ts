// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { buildMinerCategoryIndex, categoryFor } from "../../../lib/miner-category";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useFilteredBlocks } from "../../../store/use-filtered-blocks";
import { useUIStore } from "../../../store/ui-store";

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

/**
 * v0.3 transitional: per-miner unit counts came from the v0.2 `nodes`
 * snapshot. Each block contributes a single sample (units=1).
 */
export function useCumulativeBlocksThreshold(): CumulativeBlocksThresholdResult {
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
    if (filtered.length === 0) return { series: [], xMin: 0, xMax: 0 };

    const getKey = (b: (typeof blocks)[0]) =>
      mode === "byType" ? categoryFor(b.minerId, catIndex) : b.minerId;

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

    // Group blocks by key with their energy (unit count = 1 in v0.3).
    const byKey: Record<string, Array<{ energy: number; units: number }>> = {};
    const totalUnits: Record<string, number> = {};

    for (const b of cleaned) {
      const key = getKey(b);
      (byKey[key] ??= []).push({ energy: b.energy, units: 1 });
      totalUnits[key] = (totalUnits[key] ?? 0) + 1;
    }

    const keys =
      mode === "byType" ? selectedTypes.filter((t) => byKey[t]?.length) : Object.keys(byKey);

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
  }, [blocks, chainMiners, nodeDescriptors, selectedTypes, mode]);
}
