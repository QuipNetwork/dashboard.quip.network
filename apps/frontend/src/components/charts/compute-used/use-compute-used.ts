// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { resolveDeviceAccessTime } from "@/lib/device-access-time";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useFilteredBlocks } from "@/store/use-filtered-blocks";
import { useUIStore } from "@/store/ui-store";

// QPU's true per-win access time is real D-Wave anneal+readout seconds, not
// comparable in magnitude to a CPU/GPU wall-clock total — a healthy network
// can have a QPU bar that's genuinely <1% of the CPU bar's height. Floor
// QPU's *rendered* height to this fraction of the tallest bar so a
// nonzero-but-tiny total still reads as a bar instead of vanishing next to
// CPU/GPU. The label/tooltip always report the true `compute` value, never
// this floor — see `displayCompute`/`floored` below.
const MIN_VISIBLE_FRACTION = 0.03;

export interface ComputeUsedEntry {
  [key: string]: string | number | boolean;
  minerType: string;
  /** True total seconds of device access time this bar accounts for. */
  compute: number;
  /**
   * Value to plot as the bar's height. Equal to `compute` unless floored for
   * visibility (QPU only, see `MIN_VISIBLE_FRACTION`) — labels/tooltips
   * should read `compute`, not this field.
   */
  displayCompute: number;
  /** True when `displayCompute` was raised above the true `compute` to stay visible. */
  floored: boolean;
  /**
   * True when any win contributing to this bar used an estimated (rather
   * than winner-reported) access time — see `resolveDeviceAccessTime`. A
   * single estimated win taints the whole bar's certainty, so this is a
   * wholly-or-partly flag, not a fraction.
   */
  estimated: boolean;
}

/**
 * Total device access time accounted for, in seconds, grouped by
 * `aggregationMode`.
 *
 * Per-win usage comes from `resolveDeviceAccessTime`: the winner's
 * self-reported `deviceAccessTimeUs` (runtime-112+, still the minority of
 * blocks) when present, else an estimate assuming the winner participated
 * for the entire time the block was active — the block's own `miningTime`
 * for CPU/GPU/OTHER, or the fixed `QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN`
 * constant for QPU (wall-clock is meaningless for QPU; D-Wave cloud RTT
 * dominates it by 100x+). See `device-access-time.ts` for the full
 * derivation. Every block now contributes — reported or estimated — so
 * unlike the old qpu_access_time-join approach, other operators' QPU wins
 * are no longer skipped for lack of local iteration data.
 *
 * In `byType` mode every selected category is seeded to zero before
 * scanning blocks, so a type with no wins (QPU, most commonly) still
 * renders as a labeled zero entry rather than disappearing — same pattern
 * as `useActiveNodes`. `byNode` mode has no fixed key set, so nodes with no
 * contribution simply don't appear.
 */
export function useComputeUsed(): ComputeUsedEntry[] {
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);

    const totals: Record<string, number> = {};
    const estimatedCounts: Record<string, number> = {};

    if (mode === "byType") {
      for (const type of selectedTypes) {
        totals[type] = 0;
        estimatedCounts[type] = 0;
      }
    }

    for (const block of blocks) {
      const category = categoryFor(block.minerId, catIndex);
      if (mode === "byType" && !selectedTypes.includes(category)) continue;
      const key = mode === "byType" ? category : block.minerId;
      const { seconds, estimated } = resolveDeviceAccessTime(block, category);
      totals[key] = (totals[key] ?? 0) + seconds;
      if (estimated) estimatedCounts[key] = (estimatedCounts[key] ?? 0) + 1;
    }

    const keys = mode === "byType" ? [...selectedTypes] : Object.keys(totals);
    const rows = keys
      .filter((k) => totals[k] !== undefined)
      .map((k) => ({
        minerType: k,
        compute: totals[k]!,
        estimated: (estimatedCounts[k] ?? 0) > 0,
      }));

    const maxCompute = Math.max(0, ...rows.map((r) => r.compute));
    const floor = maxCompute * MIN_VISIBLE_FRACTION;

    return rows.map((r) => {
      const floored =
        mode === "byType" && r.minerType === "QPU" && r.compute > 0 && r.compute < floor;
      return {
        ...r,
        displayCompute: floored ? floor : r.compute,
        floored,
      };
    });
  }, [blocks, chainMiners, nodeDescriptors, selectedTypes, mode]);
}
