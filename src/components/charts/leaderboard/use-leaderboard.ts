import { useMemo } from "react";
import { useFilteredBlocks } from "../../../store/use-filtered-blocks";
import { useUIStore } from "../../../store/ui-store";
import type { BlockRecord, MinerCategory } from "../../../types/telemetry";

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
 */
export function computeLeaderboard(
  blocks: readonly BlockRecord[],
  filter?: LeaderboardFilter,
): LeaderboardEntry[] {
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
    if (filter?.categories && !filter.categories.has(block.minerCategory)) continue;

    const existing = stats.get(block.minerId);
    if (existing) {
      existing.blockCount++;
      existing.totalMiningTime += block.miningTime;
      existing.bestEnergy = Math.min(existing.bestEnergy, block.energy);
    } else {
      stats.set(block.minerId, {
        minerCategory: block.minerCategory,
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
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(
    () =>
      computeLeaderboard(
        blocks,
        mode === "byType" ? { categories: new Set(selectedTypes) } : undefined,
      ),
    [blocks, selectedTypes, mode],
  );
}
