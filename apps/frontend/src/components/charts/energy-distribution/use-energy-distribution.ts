// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import type { BlockRecord, MinerCategory } from "@quip/shared/telemetry";
import { bestNodeId } from "@/components/charts/mining-time-by-difficulty/mining-cost-model";
import { type NodeScope } from "@/components/charts/common/SegToggle";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useFilteredBlocks } from "@/store/use-filtered-blocks";
import { useUIStore } from "@/store/ui-store";
import { buildHistogram, type HistogramData } from "@/lib/histogram";
import { bucketIndexFor, buildEnergyBuckets, type EnergyBucket } from "./energy-buckets";

// The easy boundary sits this fraction above (easier than) the current
// difficulty target. ~0.4% of a ~-14560 target lands the boundary near -14500,
// so the histogram centres on the hard regime (target ± a little) and drops the
// easy warmup that kicks off mining. Tunable — raise to keep more of the easy
// side, lower to trim closer to the target.
const HARD_REGIME_EASY_FRAC = 0.004;

// Restrict to the current hard mining regime. Anchor to the live difficulty
// target (the topology's current threshold) and keep blocks whose achieved
// energy is at most `target + EASY_FRAC·|target|` (i.e. no easier than the
// boundary), so warmup blocks won while difficulty was still ramping drop out.
// Falls back to the hardest target observed when the live target is absent, and
// to all blocks when the clip would empty the chart.
function clipToHardRegime<T extends { energy: number; difficultyEnergy: number }>(
  blocks: T[],
  liveTarget: number | null,
): T[] {
  let target = liveTarget != null && liveTarget < 0 ? liveTarget : null;
  if (target == null) {
    const targets = blocks.map((b) => b.difficultyEnergy).filter((d) => d < 0);
    if (targets.length === 0) return blocks;
    target = Math.min(...targets); // hardest target observed
  }
  const cutoff = target + Math.abs(target) * HARD_REGIME_EASY_FRAC;
  const clipped = blocks.filter((b) => b.energy <= cutoff);
  return clipped.length > 0 ? clipped : blocks;
}

/**
 * v0.3 transitional: per-block unit counts came from the v0.2 `nodes`
 * snapshot, which no longer exists. Each block contributes a single
 * sample to the histogram (unitCount=1) until per-miner hardware lands
 * via peer-query.
 */
export function useEnergyDistribution(): HistogramData {
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const mineableTopologies = useTelemetryStore((s) => s.mineableTopologies);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  // The current difficulty target (default topology threshold) anchors the
  // hard-regime clip below.
  const liveTarget = mineableTopologies.find((t) => t.isDefault)?.difficultyEnergy ?? null;

  return useMemo(() => {
    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
    const filtered =
      mode === "byType"
        ? blocks.filter((b) => selectedTypes.includes(categoryFor(b.minerId, catIndex)))
        : blocks;

    // Focus on the current hard regime: drop the "easy" blocks that kick off
    // mining while difficulty is still ramping up from its easy end. A block's
    // own `difficultyEnergy` is the target it was won against; keep only blocks
    // whose target is within HARD_TARGET_BAND of the hardest target observed in
    // the window. This concentrates the histogram (and its bins) on results
    // near the top of the hardness range. Tunable.
    const hard = clipToHardRegime(filtered, liveTarget);

    const values = hard.map((b) => ({
      value: b.energy,
      group: mode === "byType" ? categoryFor(b.minerId, catIndex) : b.minerId,
      unitCount: 1,
    }));

    const keys = mode === "byType" ? [...selectedTypes] : [...new Set(values.map((v) => v.group))];

    // More bins than the default heuristic — the range is now narrow (the hard
    // regime only), so finer bins resolve the distribution near the target.
    return buildHistogram(values, keys, { binCount: 12 });
  }, [blocks, chainMiners, nodeDescriptors, selectedTypes, mode, liveTarget]);
}

// The three per-type mini-histograms (WU10) always show CPU/GPU/QPU — unlike
// the stacked chart above, this ignores the global type-chip selection so a
// deselected type still renders its own (empty-state) panel.
const DISTRIBUTION_TYPES: readonly MinerCategory[] = ["CPU", "GPU", "QPU"];

export interface TypeDistribution {
  type: MinerCategory;
  buckets: EnergyBucket[];
  // Parallel to `buckets`; each type's own wins as a % of that type's total —
  // sums to ~100 when totalWins > 0 (rounding keeps it from landing exactly
  // on 100 in every case), all zero when totalWins is 0.
  percentages: number[];
  totalWins: number;
}

export interface EnergyDistributionByTypeResult {
  types: TypeDistribution[]; // fixed order: CPU, GPU, QPU
}

export interface EnergyDistributionByTypeOptions {
  scope?: NodeScope;
}

function emptyTypeDistribution(
  type: MinerCategory,
  buckets: EnergyBucket[] = [],
): TypeDistribution {
  return { type, buckets, percentages: buckets.map(() => 0), totalWins: 0 };
}

/**
 * Per-type (CPU/GPU/QPU) self-normalised energy histograms for
 * `EnergyDistributionCard`. Each type's bars are normalised against ITSELF —
 * see {@link ./energy-buckets} for the bucket/anchor math and the "which end
 * is hardest" sign-convention writeup. Scoped to the chain's CURRENT
 * topology only (the tip block's `topologyHash`), so the anchor doesn't mix
 * energies from a topology that's since been superseded.
 */
export function useEnergyDistributionByType(
  opts: EnergyDistributionByTypeOptions = {},
): EnergyDistributionByTypeResult {
  const scope = opts.scope ?? "all";
  const blocks = useTelemetryStore((s) => s.blocks);
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);

  return useMemo(() => {
    // blocks ship DESC by substrate_block_number, so blocks[0] is the tip.
    const tip = blocks[0] ?? null;
    const onTopology = tip == null ? [] : blocks.filter((b) => b.topologyHash === tip.topologyHash);
    if (onTopology.length === 0) {
      return { types: DISTRIBUTION_TYPES.map((t) => emptyTypeDistribution(t)) };
    }

    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
    const hardest = Math.min(...onTopology.map((b) => b.energy));
    const buckets = buildEnergyBuckets(hardest);

    const groups = new Map<MinerCategory, BlockRecord[]>();
    for (const b of onTopology) {
      const cat = categoryFor(b.minerId, catIndex);
      if (!DISTRIBUTION_TYPES.includes(cat)) continue;
      const group = groups.get(cat);
      if (group) group.push(b);
      else groups.set(cat, [b]);
    }

    return {
      types: DISTRIBUTION_TYPES.map((type) => {
        let group = groups.get(type) ?? [];
        if (scope === "best" && group.length > 0) {
          const id = bestNodeId(group);
          group = group.filter((b) => b.minerId === id);
        }
        if (group.length === 0) return emptyTypeDistribution(type, buckets);

        const counts = new Array<number>(buckets.length).fill(0);
        for (const b of group) {
          const idx = bucketIndexFor(buckets, b.energy);
          counts[idx] = (counts[idx] ?? 0) + 1;
        }
        const total = group.length;
        const percentages = counts.map((c) => Math.round((c / total) * 1000) / 10);
        return { type, buckets, percentages, totalWins: total };
      }),
    };
  }, [blocks, chainMiners, nodeDescriptors, scope]);
}
