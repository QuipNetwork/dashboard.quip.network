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

export interface EnergySeries {
  id: MinerCategory;
  // x = on-chain qblock id, y = estimated joules for this type on that qblock.
  data: Array<{ x: number; y: number }>;
}

export interface EnergyPerQblockState {
  series: EnergySeries[];
  /** Σ joules over every plotted qblock and type. */
  totalJoules: number;
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
    for (const row of history.rows) {
      const cats = byQblock.get(row.qblockId);
      if (!cats || cats.length === 0) continue;
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
      series,
      totalJoules,
      loading: history.loading,
      error: history.error,
      isEmpty: !history.loading && series.length === 0,
    };
  }, [history, participationCompute]);
}
