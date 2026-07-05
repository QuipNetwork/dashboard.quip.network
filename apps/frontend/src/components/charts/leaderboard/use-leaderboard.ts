// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useMinerWins } from "@/services/use-miner-wins";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import type {
  ChainMinerRecord,
  MinerCategory,
  MinerWinsRow,
  NodeDescriptorRecord,
} from "@quip/shared/telemetry";

export interface LeaderboardEntry {
  rank: number;
  minerId: string;
  minerCategory: MinerCategory;
  // Chain-authoritative lifetime wins (`quantum_pow.Miners.proofs_won`).
  blockCount: number;
  /** Share of total wins (within the filtered set) as 0–1 */
  share: number;
  /**
   * Average mining time in seconds over the miner's INDEXED wins — null when
   * none of this miner's winning blocks have been decoded locally yet.
   */
  avgMiningTime: number | null;
  /** Best (lowest) energy across the miner's indexed wins; null as above. */
  bestEnergy: number | null;
  /**
   * Sum of `resolveDeviceAccessTime(block, category).seconds` over the
   * miner's indexed wins — populated by `leaderboard-modes.ts`'s
   * `withTimeEnergyTotals`, not by `computeLeaderboard` itself. Undefined
   * until a caller joins the indexed `blocks` window; null when joined but
   * the miner has no indexed wins.
   */
  totalMiningSeconds?: number | null;
  /** Sum of `estimateEnergyJoules(...)` over the same indexed wins. */
  totalEnergyJoules?: number | null;
  /**
   * True when at least one win behind `totalMiningSeconds`/`totalEnergyJoules`
   * used an estimated (not self-reported) device-access time.
   */
  estimated?: boolean;
}

export interface LeaderboardFilter {
  categories?: ReadonlySet<MinerCategory>;
}

/**
 * Pure leaderboard computation. Rank, win count, and share come from the
 * chain-authoritative `proofs_won` counter (chainMiners) — the same number
 * the rewards line and the On-chain miners table show, so every surface
 * agrees. The indexed `/api/miner-wins` dataset only supplies the quality
 * metrics the chain doesn't store (avg mining time, best energy); those are
 * null for miners whose wins the indexer hasn't decoded yet (pre-spec-108
 * backfill). Zero-win miners are excluded — it's a leaderboard of winners.
 *
 * Extracted so views that need a canonical ranking (e.g. "My Node" showing
 * the operator their network-wide rank) can reuse the exact same logic
 * without being coupled to the UI store's filter.
 *
 * v0.3: categories come from a `chainMiners` lookup (every miner currently
 * resolves to "OTHER" until per-miner hardware lands; see lib/miner-category).
 */
export function computeLeaderboard(
  chainMiners: readonly ChainMinerRecord[],
  minerWins: readonly MinerWinsRow[],
  filter?: LeaderboardFilter,
  nodeDescriptors: readonly NodeDescriptorRecord[] = [],
): LeaderboardEntry[] {
  const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
  const metricsByMiner = new Map(minerWins.map((w) => [w.minerId, w]));

  const included = chainMiners
    .map((m) => ({
      m,
      wins: Number(m.proofsWon),
      minerCategory: categoryFor(m.accountId, catIndex),
    }))
    .filter(({ wins }) => wins > 0)
    .filter(({ minerCategory }) => !filter?.categories || filter.categories.has(minerCategory));

  // Share is of the *included* total: in byType mode the bars answer "who
  // wins among the selected categories".
  const totalWins = included.reduce((sum, { wins }) => sum + wins, 0);

  return included
    .sort((a, b) => b.wins - a.wins)
    .map(({ m, wins, minerCategory }, i) => {
      const metrics = metricsByMiner.get(m.accountId);
      return {
        rank: i + 1,
        minerId: m.accountId,
        minerCategory,
        blockCount: wins,
        share: totalWins > 0 ? wins / totalWins : 0,
        avgMiningTime: metrics?.avgMiningTime ?? null,
        bestEnergy: metrics?.bestEnergy ?? null,
      };
    });
}

export function filterLeaderboardEntries(
  entries: readonly LeaderboardEntry[],
  query: string,
): LeaderboardEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter(
    (e) => e.minerId.toLowerCase().includes(q) || e.minerCategory.toLowerCase().includes(q),
  );
}

export function useLeaderboard(): LeaderboardEntry[] {
  const { rows } = useMinerWins();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(
    () =>
      computeLeaderboard(
        chainMiners,
        rows,
        mode === "byType" ? { categories: new Set(selectedTypes) } : undefined,
        nodeDescriptors,
      ),
    [rows, chainMiners, nodeDescriptors, selectedTypes, mode],
  );
}
