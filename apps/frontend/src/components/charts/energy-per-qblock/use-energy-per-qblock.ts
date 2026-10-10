// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Estimated electrical energy per qblock, stacked by processor type: every
// participant that raced the qblock, charged its category's default device
// watts × energySeconds (see participation-compute.ts: the block-active
// window for CPU/GPU/OTHER, the reserved window for the QPU). The rows from
// /api/mining-history bound the window and order the x-axis; the values come
// from store.participationCompute, so qblocks outside the participation
// window contribute no point. No per-participant node is available in the
// aggregate, so watts are the category defaults, as in Mining per QBlock.

import { useMemo } from "react";

import type { TimeRange } from "@/components/charts/common/time-range";
import { useMiningHistory } from "@/components/charts/common/use-mining-history";
import { estimateDeviceWatts, estimateEnergyJoules } from "@/lib/hardware-power";
import { useTelemetryStore } from "@/store/telemetry-store";
import { aggregateParticipationByQblock, type MinerCategory } from "@quip/shared/telemetry";

// Stack order, bottom to top. Every plotted qblock carries one point per
// type (0 when absent) so nivo's stacked areas share an x-domain.
export const ENERGY_STACK_ORDER: readonly MinerCategory[] = ["CPU", "GPU", "QPU", "OTHER"];
export const ENERGY_MAX_POINTS = 600;

export interface EnergySeries {
  id: MinerCategory;
  // x = last on-chain qblock id in the bucket; y = mean joules per qblock.
  data: Array<{ x: number; y: number }>;
}

/** Average consecutive points on the aligned qblock domain, keeping joules per qblock. */
export function bucketEnergySeries(series: EnergySeries[]): {
  series: EnergySeries[];
  bucketSize: number;
} {
  const count = series[0]?.data.length ?? 0;
  const bucketSize = Math.max(1, Math.ceil(count / ENERGY_MAX_POINTS));
  if (bucketSize === 1) return { series, bucketSize };

  return {
    bucketSize,
    series: series.map(({ id, data }) => {
      const points: EnergySeries["data"] = [];
      for (let start = 0; start < data.length; start += bucketSize) {
        const end = Math.min(start + bucketSize, data.length);
        let joules = 0;
        for (let i = start; i < end; i++) joules += data[i]!.y;
        points.push({ x: data[end - 1]!.x, y: joules / (end - start) });
      }
      return { id, data: points };
    }),
  };
}

export interface EnergyPerQblockState {
  series: EnergySeries[];
  /** Σ joules over every original qblock and type, before bucketing. */
  totalJoules: number;
  bucketSize: number;
  plottedQblocks: number;
  rangeQblocks: number;
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
}

export function useEnergyPerQblock(
  range: TimeRange,
  opts: { now?: () => number; refreshMs?: number } = {},
): EnergyPerQblockState {
  const history = useMiningHistory(range, opts);
  const participationCompute = useTelemetryStore((s) => s.participationCompute);

  return useMemo(() => {
    const byQblock = aggregateParticipationByQblock(participationCompute);
    const points = new Map<MinerCategory, Array<{ x: number; y: number }>>(
      ENERGY_STACK_ORDER.map((category) => [category, []]),
    );
    let totalJoules = 0;
    let plottedQblocks = 0;
    for (const row of history.rows) {
      const cats = byQblock.get(row.qblockId);
      if (!cats || cats.length === 0) continue;
      plottedQblocks += 1;
      const x = Number(row.qblockId);
      for (const category of ENERGY_STACK_ORDER) {
        const compute = cats.find((c) => c.category === category);
        const y = compute
          ? estimateEnergyJoules(estimateDeviceWatts(category, null), compute.energySeconds)
          : 0;
        points.get(category)?.push({ x, y });
        totalJoules += y;
      }
    }
    const series: EnergySeries[] = [];
    for (const category of ENERGY_STACK_ORDER) {
      const data = points.get(category) ?? [];
      if (data.some((p) => p.y > 0)) series.push({ id: category, data });
    }
    return {
      ...bucketEnergySeries(series),
      totalJoules,
      plottedQblocks,
      rangeQblocks: history.rows.length,
      loading: history.loading,
      error: history.error,
      isEmpty: !history.loading && series.length === 0,
    };
  }, [history, participationCompute]);
}
