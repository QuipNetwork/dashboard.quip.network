// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useFilteredBlocks } from "@/store/use-filtered-blocks";
import { useUIStore } from "@/store/ui-store";
import { buildHistogram, type HistogramData } from "@/lib/histogram";

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
