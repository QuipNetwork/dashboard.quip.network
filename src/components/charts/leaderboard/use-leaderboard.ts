// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { buildMinerCategoryIndex, categoryFor } from "../../../lib/miner-category";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useFilteredBlocks } from "../../../store/use-filtered-blocks";
import { useUIStore } from "../../../store/ui-store";
import type { BlockRecord, ChainMinerRecord, MinerCategory } from "../../../types/telemetry";

export interface LeaderboardEntry {
  rank: number;
  minerId: string;
  minerCategory: MinerCategory;
  blockCount: number;
  /** Share of total blocks as 0–1 */
  share: number;
  /** Average mining time in seconds */
  avgMiningTime: number;
  /** Best (lowest) energy achieved */
  bestEnergy: number;
}

export interface LeaderboardFilter {
  categories?: ReadonlySet<MinerCategory>;
}

/**
 * Pure leaderboard computation. Extracted so views that need a canonical
 * ranking (e.g. "My Node" showing the operator their network-wide rank) can
 * reuse the exact same logic without being coupled to the UI store's filter.
 *
 * v0.3: categories come from a `chainMiners` lookup (every miner currently
 * resolves to "OTHER" until per-miner hardware lands; see lib/miner-category).
 */
export function computeLeaderboard(
  blocks: readonly BlockRecord[],
  chainMiners: readonly ChainMinerRecord[],
  filter?: LeaderboardFilter,
): LeaderboardEntry[] {
  const catIndex = buildMinerCategoryIndex(chainMiners);
  const stats = new Map<
    string,
    {
      minerCategory: MinerCategory;
      blockCount: number;
      totalMiningTime: number;
      bestEnergy: number;
    }
  >();

  for (const block of blocks) {
    const minerCategory = categoryFor(block.minerId, catIndex);
    if (filter?.categories && !filter.categories.has(minerCategory)) continue;

    const existing = stats.get(block.minerId);
    if (existing) {
      existing.blockCount++;
      existing.totalMiningTime += block.miningTime;
      existing.bestEnergy = Math.min(existing.bestEnergy, block.energy);
    } else {
      stats.set(block.minerId, {
        minerCategory,
        blockCount: 1,
        totalMiningTime: block.miningTime,
        bestEnergy: block.energy,
      });
    }
  }

  const totalBlocks = [...stats.values()].reduce((sum, s) => sum + s.blockCount, 0);

  return [...stats.entries()]
    .sort((a, b) => b[1].blockCount - a[1].blockCount)
    .map(([minerId, s], i) => ({
      rank: i + 1,
      minerId,
      minerCategory: s.minerCategory,
      blockCount: s.blockCount,
      share: totalBlocks > 0 ? s.blockCount / totalBlocks : 0,
      avgMiningTime: s.totalMiningTime / s.blockCount,
      bestEnergy: s.bestEnergy,
    }));
}

export function useLeaderboard(): LeaderboardEntry[] {
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(
    () =>
      computeLeaderboard(
        blocks,
        chainMiners,
        mode === "byType" ? { categories: new Set(selectedTypes) } : undefined,
      ),
    [blocks, chainMiners, selectedTypes, mode],
  );
}
