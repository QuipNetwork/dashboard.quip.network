// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import type { BlockRecord, MinerCategory } from "@quip/shared/telemetry";
import { bandByKey, censusUnitCounts, type Band } from "@/components/charts/common/band-by-key";
import type { NodeScope } from "@/components/charts/common/SegToggle";
import {
  buildNormalizedComposition,
  type PerfPoint,
} from "@/components/charts/common/normalized-composition";
import { filterToBestNodes } from "@/components/charts/mining-time-by-difficulty/mining-cost-model";
import { clipToDifficultyFloor } from "@/lib/difficulty-curve";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useFilteredBlocks } from "@/store/use-filtered-blocks";
import { useUIStore } from "@/store/ui-store";

// "all" | "best" are the shared node scopes; "normalized" models the fixed
// hypothetical composition (see charts/common/normalized-composition).
export type WinRateMode = NodeScope | "normalized";

export interface WinRateByDifficultyOptions {
  mode?: WinRateMode;
}

export interface WinRateSeries {
  id: string;
  // Display label when it differs from the id ("QPU100" renders as "QPU100%").
  label?: string;
  data: Array<{ x: number; y: number }>;
}

export interface WinRateByDifficultyResult {
  series: WinRateSeries[];
  xMin: number;
  xMax: number;
}

const NUM_BANDS = 12;
const EMPTY: WinRateByDifficultyResult = { series: [], xMin: 0, xMax: 0 };
const COMPOSITION_TYPES = ["CPU", "GPU", "QPU"] as const;

function winsByCategory(
  blocks: BlockRecord[],
  catIndex: ReadonlyMap<string, MinerCategory>,
): Partial<Record<MinerCategory, number>> {
  const wins: Partial<Record<MinerCategory, number>> = {};
  for (const b of blocks) {
    const cat = categoryFor(b.minerId, catIndex);
    wins[cat] = (wins[cat] ?? 0) + 1;
  }
  return wins;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

// Observed win share per type and band: (type wins in band) / (band size).
function buildObservedSeries(
  bands: Array<Band<BlockRecord>>,
  catIndex: ReadonlyMap<string, MinerCategory>,
  selectedTypes: string[],
): WinRateSeries[] {
  const series: Record<string, Array<{ x: number; y: number }>> = {};
  for (const type of selectedTypes) series[type] = [];

  for (const band of bands) {
    const wins = winsByCategory(band.items, catIndex);
    for (const type of selectedTypes) {
      const rate = ((wins[type as MinerCategory] ?? 0) / band.items.length) * 100;
      series[type]!.push({ x: band.midpoint, y: round1(rate) });
    }
  }

  return selectedTypes
    .filter((type) => series[type]!.some((d) => d.y > 0))
    .map((type) => ({ id: type, data: series[type]! }));
}

// Normalized mode: per-unit average performance = (type wins in band) /
// (devices of that type the category index knows about). Registered devices
// that never win drag the average down — that is what "average performance of
// all CPUs/GPUs" means; the index is the closest census we have. The QPU curve
// is observed under its 20 min/day budget; the composition module splits it
// into QPU20m/QPU100%.
function buildNormalizedSeries(
  bands: Array<Band<BlockRecord>>,
  catIndex: ReadonlyMap<string, MinerCategory>,
): WinRateSeries[] {
  const unitCounts = censusUnitCounts(catIndex);

  const perUnit: Record<(typeof COMPOSITION_TYPES)[number], PerfPoint[]> = {
    CPU: [],
    GPU: [],
    QPU: [],
  };
  for (const band of bands) {
    const wins = winsByCategory(band.items, catIndex);
    for (const type of COMPOSITION_TYPES) {
      const n = unitCounts[type];
      perUnit[type].push({ x: band.midpoint, y: n > 0 ? (wins[type] ?? 0) / n : 0 });
    }
  }

  return buildNormalizedComposition(perUnit).map((s) => ({
    id: s.id,
    label: s.label,
    data: s.data.map((p) => ({ x: p.x, y: round1(p.y) })),
  }));
}

export function useWinRateByDifficulty(
  opts: WinRateByDifficultyOptions = {},
): WinRateByDifficultyResult {
  const mode = opts.mode ?? "all";
  const allBlocks = useTelemetryStore((s) => s.blocks);
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const selectedTypes = useUIStore((s) => s.selectedTypes);

  return useMemo(() => {
    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);

    let pool: BlockRecord[];
    if (mode === "normalized") {
      // The hypothetical composition is fixed (10k CPU / 100 GPU / one QPU in
      // two regimes), so the per-type chips don't apply here — always draw
      // from the unfiltered block stream.
      pool = allBlocks;
    } else {
      pool = blocks.filter((b) => selectedTypes.includes(categoryFor(b.minerId, catIndex)));
      if (mode === "best") {
        // Same semantics as Mining Cost by Difficulty: each type narrowed to
        // its single top winner.
        pool = filterToBestNodes(pool, (id) => categoryFor(id, catIndex));
      }
    }
    if (pool.length === 0) return EMPTY;

    // Start the axis where real data is: drop easy warmup targets before banding.
    const inRegime = clipToDifficultyFloor(pool);
    const sorted = [...inRegime].sort((a, b) => a.difficultyEnergy - b.difficultyEnergy);

    // Remove outliers via IQR so extreme values don't blow up the x-axis
    const q1 = sorted[Math.floor(sorted.length * 0.25)]!.difficultyEnergy;
    const q3 = sorted[Math.floor(sorted.length * 0.75)]!.difficultyEnergy;
    const iqr = q3 - q1;
    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;
    const cleaned = sorted.filter(
      (b) => b.difficultyEnergy >= lower && b.difficultyEnergy <= upper,
    );
    if (cleaned.length === 0) return EMPTY;

    const bands = bandByKey(cleaned, NUM_BANDS, (b) => b.difficultyEnergy);

    const series =
      mode === "normalized"
        ? buildNormalizedSeries(bands, catIndex)
        : buildObservedSeries(bands, catIndex, selectedTypes);

    // 5a: the domain must equal the span of plotted points. Points sit at band
    // midpoints (per-band average difficulty), strictly inside the raw
    // [min, max] whenever a band mixes difficulties — using the raw extremes
    // left every line floating short of both chart edges. Tighten the domain
    // to the first/last midpoints (real data) rather than padding the series
    // out to the raw extremes (fabricated values).
    return {
      series,
      xMin: bands[0]!.midpoint,
      xMax: bands[bands.length - 1]!.midpoint,
    };
  }, [allBlocks, blocks, chainMiners, nodeDescriptors, selectedTypes, mode]);
}
