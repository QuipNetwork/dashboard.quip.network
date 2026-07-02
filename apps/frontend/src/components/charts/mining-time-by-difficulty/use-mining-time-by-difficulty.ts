// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { clipToDifficultyFloor } from "@/lib/difficulty-curve";
import { displayNodeName } from "@/lib/format-chain";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useFilteredBlocks } from "@/store/use-filtered-blocks";
import { bestNodeId, buildAttemptsCurve, meanEventInterval } from "./mining-cost-model";

export type CostUnits = "time" | "attempts";
export type CostScope = "all" | "best";

export interface MiningCostOptions {
  units: CostUnits;
  scope: CostScope;
}

export interface MiningCostSeries {
  id: string;
  data: Array<{ x: number; y: number }>;
}

export interface MiningTimeByDifficultyResult {
  series: MiningCostSeries[];
  xMin: number;
  xMax: number;
  units: CostUnits;
  // Human-readable reason the chart is empty (insufficient data), else null.
  note: string | null;
}

const NUM_POINTS = 50;
// Below this, the empirical CDF is too coarse to estimate a curve from.
const MIN_OBSERVATIONS = 3;
// IQR axis-trimming only kicks in with enough points to have stable quartiles;
// small (e.g. best-node) sets are kept intact.
const IQR_MIN = 8;

function empty(units: CostUnits, note: string | null): MiningTimeByDifficultyResult {
  return { series: [], xMin: 0, xMax: 0, units, note };
}

// Trim achieved-energy outliers via the 1.5·IQR fence so a single freak deep
// solution doesn't stretch the axis. Mirrors the energy-cdf sibling. No-op
// below IQR_MIN points.
function trimEnergyOutliers<T extends { energy: number }>(blocks: T[]): T[] {
  if (blocks.length < IQR_MIN) return blocks;
  const sorted = blocks.map((b) => b.energy).sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)]!;
  const q3 = sorted[Math.floor(sorted.length * 0.75)]!;
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  return blocks.filter((b) => b.energy >= lower && b.energy <= upper);
}

/**
 * Probability/rate model for "Mining Cost by Difficulty". See
 * {@link ./mining-cost-model} for the math. Renders one curve, scoped to the
 * whole network or the single highest-winning node, in either expected-attempts
 * or calibrated-time units. Honors the global `selectedTypes` filter via
 * {@link useFilteredBlocks}; the chart no longer breaks out per-type series.
 */
export function useMiningTimeByDifficulty(opts: MiningCostOptions): MiningTimeByDifficultyResult {
  const { units, scope } = opts;
  const blocks = useFilteredBlocks();
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);

  return useMemo(() => {
    // Drop easy warmup targets so the axis starts where real data is.
    const floored = clipToDifficultyFloor(blocks);
    if (floored.length < MIN_OBSERVATIONS) return empty(units, "Not enough qblocks yet");

    let scoped = floored;
    let label = "All Nodes";
    if (scope === "best") {
      const id = bestNodeId(floored);
      if (id == null) return empty(units, "No qblocks yet");
      scoped = floored.filter((b) => b.minerId === id);
      const name = nodeDescriptors.find((d) => d.accountId === id)?.descriptor.nodeName;
      label = displayNodeName(id, name);
    }
    if (scoped.length < MIN_OBSERVATIONS) {
      return empty(units, `Best node has only ${scoped.length} qblocks — not enough to estimate`);
    }

    const cleaned = trimEnergyOutliers(scoped);
    const curve = buildAttemptsCurve(
      cleaned.map((b) => b.energy),
      NUM_POINTS,
    );
    if (curve.points.length === 0) return empty(units, "No qblocks yet");

    let scale = 1; // attempts mode
    if (units === "time") {
      const t = meanEventInterval(cleaned.map((b) => b.timestamp));
      if (t == null) return empty(units, "Need ≥2 events for a time estimate");
      scale = t; // seconds per mining event
    }

    const data = curve.points.map((p) => ({ x: p.x, y: p.attempts * scale }));
    return { series: [{ id: label, data }], xMin: curve.xMin, xMax: curve.xMax, units, note: null };
  }, [blocks, nodeDescriptors, units, scope]);
}
