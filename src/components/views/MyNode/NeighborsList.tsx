// SPDX-License-Identifier: AGPL-3.0-or-later

import { SERIES_COLORS } from "@/lib/colors";
import { formatNumber, formatSeconds } from "@/lib/format";
import { useMinerColors } from "@/store/miner-colors";
import type { LeaderboardEntry } from "@/components/charts/leaderboard/use-leaderboard";

interface NeighborsListProps {
  self: LeaderboardEntry | null;
  neighbors: LeaderboardEntry[];
}

export function NeighborsList({ self, neighbors }: NeighborsListProps) {
  // Interleave self into the neighbor list at the right rank position so the
  // operator can see their row in context rather than scanning two panels.
  const combined = self ? mergeByRank([...neighbors, { ...self, isSelf: true }]) : neighbors;

  if (combined.length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-accent text-sm text-brand-gray-3">
        No rank-adjacent miners to show yet
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <table className="w-full">
        <thead>
          <tr className="sticky top-0 bg-brand-gray-1/80 text-left font-accent text-[10px] uppercase tracking-wider text-brand-gray-3 backdrop-blur-sm">
            <th className="pb-2 pl-1 pr-2">#</th>
            <th className="pb-2 pr-3">Miner</th>
            <th className="pb-2 pr-3">Type</th>
            <th className="pb-2 pr-3 text-right">Solutions</th>
            <th className="hidden pb-2 pr-3 text-right sm:table-cell">Avg Time</th>
            <th className="hidden pb-2 pr-3 text-right md:table-cell">Best Energy</th>
          </tr>
        </thead>
        <tbody>
          {combined.map((entry) => {
            const typeColor = SERIES_COLORS[entry.minerCategory];
            const minerColor = useMinerColors.getState().getColor(entry.minerId);
            const isSelf = "isSelf" in entry && entry.isSelf === true;
            return (
              <tr
                key={entry.minerId}
                className="border-t border-brand-gray-2/40 transition-colors hover:bg-brand-gray-2/20"
                style={isSelf ? { background: `${typeColor}10` } : undefined}
              >
                <td className="py-2 pl-1 pr-2 font-accent text-sm text-brand-gray-5">
                  {entry.rank}
                </td>
                <td className="py-2 pr-3">
                  <span className="flex items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: minerColor, boxShadow: `0 0 6px ${minerColor}66` }}
                    />
                    <span className="font-accent text-sm text-brand-gray-5">
                      {entry.minerId}
                      {isSelf && (
                        <span
                          className="ml-2 rounded-md px-1.5 py-0.5 font-accent text-[9px] font-bold uppercase tracking-wider"
                          style={{
                            color: typeColor,
                            border: `1px solid ${typeColor}66`,
                            backgroundColor: `${typeColor}18`,
                          }}
                        >
                          You
                        </span>
                      )}
                    </span>
                  </span>
                </td>
                <td className="py-2 pr-3">
                  <span
                    className="inline-block rounded-md px-1.5 py-0.5 font-accent text-[10px] font-bold uppercase tracking-wider"
                    style={{
                      color: typeColor,
                      backgroundColor: `${typeColor}18`,
                      border: `1px solid ${typeColor}33`,
                    }}
                  >
                    {entry.minerCategory}
                  </span>
                </td>
                <td className="py-2 pr-3 text-right font-heading text-sm text-brand-gray-5">
                  {formatNumber(entry.blockCount)}
                </td>
                <td className="hidden py-2 pr-3 text-right font-accent text-xs text-brand-gray-3 sm:table-cell">
                  {formatSeconds(entry.avgMiningTime)}
                </td>
                <td className="hidden py-2 pr-3 text-right font-accent text-xs text-brand-gray-3 md:table-cell">
                  {formatNumber(entry.bestEnergy)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type AugmentedEntry = LeaderboardEntry & { isSelf?: boolean };

function mergeByRank(entries: AugmentedEntry[]): AugmentedEntry[] {
  return [...entries].sort((a, b) => a.rank - b.rank);
}
