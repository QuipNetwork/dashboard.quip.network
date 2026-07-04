// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import type { NodeScope } from "@/components/charts/common/SegToggle";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { clipToDifficultyFloor } from "@/lib/difficulty-curve";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useFilteredBlocks } from "@/store/use-filtered-blocks";
import { useUIStore } from "@/store/ui-store";
import type { BlockRecord } from "@quip/shared/telemetry";
import { bestNodeId, buildAttemptsCurve, meanEventInterval } from "./mining-cost-model";

export type CostUnits = "time" | "attempts";

export interface MiningCostOptions {
  units: CostUnits;
  scope: NodeScope;
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

// One type's curve, or null when the group is too sparse to estimate.
function buildTypeSeries(
  id: string,
  group: BlockRecord[],
  units: CostUnits,
): { series: MiningCostSeries; xMin: number; xMax: number } | null {
  if (group.length < MIN_OBSERVATIONS) return null;

  const cleaned = trimEnergyOutliers(group);
  const curve = buildAttemptsCurve(
    cleaned.map((b) => b.energy),
    NUM_POINTS,
  );
  if (curve.points.length === 0) return null;

  let scale = 1; // attempts mode
  if (units === "time") {
    const t = meanEventInterval(cleaned.map((b) => b.timestamp));
    if (t == null) return null; // need >=2 events for a cadence
    scale = t; // seconds per mining event
  }

  const data = curve.points.map((p) => ({ x: p.x, y: p.attempts * scale }));
  return { series: { id, data }, xMin: curve.xMin, xMax: curve.xMax };
}

/**
 * Probability/rate model for "Mining Cost by Difficulty". See
 * {@link ./mining-cost-model} for the math. Renders one curve per processor
 * type (CPU/GPU/QPU, honouring the global `selectedTypes` filter via
 * {@link useFilteredBlocks}), in either expected-attempts or calibrated-time
 * units. "all" pools every winner of a type; "best" narrows each type to its
 * single highest-winning node before estimating.
 */
export function useMiningTimeByDifficulty(opts: MiningCostOptions): MiningTimeByDifficultyResult {
  const { units, scope } = opts;
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const selectedTypes = useUIStore((s) => s.selectedTypes);

  return useMemo(() => {
    // Drop easy warmup targets so the axis starts where real data is.
    const floored = clipToDifficultyFloor(blocks);
    if (floored.length < MIN_OBSERVATIONS) return empty(units, "Not enough qblocks yet");

    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
    const groups = new Map<string, BlockRecord[]>();
    for (const b of floored) {
      const cat = categoryFor(b.minerId, catIndex);
      const group = groups.get(cat);
      if (group) group.push(b);
      else groups.set(cat, [b]);
    }

    // Stable legend order: the type-chip order when a selection is active,
    // else whatever categories the (unfiltered) blocks resolve to.
    const order = selectedTypes.length > 0 ? selectedTypes : [...groups.keys()].sort();

    const built: Array<{ series: MiningCostSeries; xMin: number; xMax: number }> = [];
    for (const type of order) {
      let group = groups.get(type);
      if (!group) continue;
      if (scope === "best") {
        const id = bestNodeId(group);
        group = group.filter((b) => b.minerId === id);
      }
      // The cadence-based time estimate is wall clock; for QPUs that is
      // dominated by D-Wave cloud round-trip + queue, not device time, so the
      // time-mode label says QPUWC. A true device-time "QPU" series can join
      // it once per-win qpu_access_time_us data exists (miner-side emit
      // pending — see MinerSubmission.qpuAccessTimeUs).
      const seriesId = units === "time" && type === "QPU" ? "QPUWC" : type;
      const result = buildTypeSeries(seriesId, group, units);
      if (result) built.push(result);
    }

    if (built.length === 0) return empty(units, "Not enough qblocks per type to estimate");

    return {
      series: built.map((b) => b.series),
      xMin: Math.min(...built.map((b) => b.xMin)),
      xMax: Math.max(...built.map((b) => b.xMax)),
      units,
      note: null,
    };
  }, [blocks, chainMiners, nodeDescriptors, selectedTypes, units, scope]);
}
