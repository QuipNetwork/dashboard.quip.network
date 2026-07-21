// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import type { BlockRecord, MinerCategory } from "@quip/shared/telemetry";
import { bestNodeId } from "@/components/charts/mining-time-by-difficulty/mining-cost-model";
import { type NodeScope } from "@/components/charts/common/SegToggle";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useTelemetryStore } from "@/store/telemetry-store";
import { bucketIndexFor, buildEnergyBuckets, type EnergyBucket } from "./energy-buckets";

// The three per-type mini-histograms (WU10) always show CPU/GPU/QPU — this
// ignores the global type-chip selection so a deselected type still renders
// its own (empty-state) panel.
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
    // When the tip predates the topologyHash migration, tip.topologyHash is
    // null and this filter degrades to the null-cohort (every other
    // pre-migration block) rather than a real topology scope.
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
