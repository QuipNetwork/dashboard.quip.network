import { useMemo, useState } from "react";

import clsx from "clsx";
import { SearchInput } from "@/components/common/SearchInput";
import { SortableHeaderCell } from "@/components/common/SortableHeaderCell";
import { useNodeIdentityModal } from "@/components/common/use-node-identity-modal";
import { SERIES_COLORS } from "@/lib/colors";
import { displayNodeName, formatEnergy } from "@/lib/format-chain";
import { formatSeconds, formatNumber } from "@/lib/format";
import { useTableSort, type SortAccessors } from "@/lib/table-sort";
import { useMinerColors } from "@/store/miner-colors";
import { filterLeaderboardEntries, type LeaderboardEntry } from "./use-leaderboard";

type LeaderboardSortColumn =
  | "rank"
  | "node"
  | "type"
  | "qblocks"
  | "avgTime"
  | "bestEnergy"
  | "share";

const RANK_STYLES: Record<number, string> = {
  1: "from-yellow-400 to-amber-500 text-black shadow-[0_0_12px_rgba(251,191,36,0.4)]",
  2: "from-gray-300 to-gray-400 text-black shadow-[0_0_8px_rgba(156,163,175,0.3)]",
  3: "from-amber-600 to-amber-700 text-white shadow-[0_0_8px_rgba(217,119,6,0.3)]",
};

function RankBadge({ rank }: { rank: number }) {
  if (rank <= 3) {
    return (
      <span
        className={clsx(
          "inline-flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br font-heading text-xs font-bold",
          RANK_STYLES[rank],
        )}
      >
        {rank}
      </span>
    );
  }
  return (
    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border font-accent text-xs text-ink-subtle">
      {rank}
    </span>
  );
}

function ShareBar({ share, color }: { share: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${(share * 100).toFixed(1)}%`,
            background: `linear-gradient(90deg, ${color}, ${color}88)`,
            boxShadow: `0 0 8px ${color}44`,
          }}
        />
      </div>
      <span className="w-12 text-right font-accent text-xs text-ink-subtle">
        {(share * 100).toFixed(1)}%
      </span>
    </div>
  );
}

interface LeaderboardProps {
  data: LeaderboardEntry[];
}

export function Leaderboard({ data }: LeaderboardProps) {
  const [query, setQuery] = useState("");
  const { open, nameOf, modal } = useNodeIdentityModal();

  const sortAccessors = useMemo<SortAccessors<LeaderboardEntry, LeaderboardSortColumn>>(
    () => ({
      rank: (e) => e.rank,
      node: (e) => displayNodeName(e.minerId, nameOf(e.minerId)),
      type: (e) => e.minerCategory,
      qblocks: (e) => e.blockCount,
      avgTime: (e) => e.avgMiningTime,
      bestEnergy: (e) => e.bestEnergy,
      share: (e) => e.share,
    }),
    [nameOf],
  );
  const filtered = filterLeaderboardEntries(data, query);
  const { sorted, sort, onSort } = useTableSort(filtered, sortAccessors, {
    column: "rank",
    direction: "asc",
  });

  if (data.length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-accent text-sm text-ink-subtle">
        No mining data available
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <SearchInput value={query} onChange={setQuery} placeholder="Search miners…" />
      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "#d4d4d8 transparent" }}
      >
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center font-accent text-sm text-ink-subtle">
            No miners match “{query}”
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="sticky top-0 bg-surface-1/80 text-left font-accent text-[10px] uppercase tracking-wider text-ink-subtle backdrop-blur-sm">
                <SortableHeaderCell
                  label="#"
                  column="rank"
                  sort={sort}
                  onClick={onSort}
                  className="pb-2 pl-1 pr-2"
                />
                <SortableHeaderCell
                  label="Node"
                  column="node"
                  sort={sort}
                  onClick={onSort}
                  className="pb-2 pr-3"
                />
                <SortableHeaderCell
                  label="Type"
                  column="type"
                  sort={sort}
                  onClick={onSort}
                  className="pb-2 pr-3"
                />
                <SortableHeaderCell
                  label="QBlocks"
                  column="qblocks"
                  sort={sort}
                  onClick={onSort}
                  align="right"
                  className="pb-2 pr-3"
                />
                <SortableHeaderCell
                  label="Avg Time"
                  column="avgTime"
                  sort={sort}
                  onClick={onSort}
                  align="right"
                  className="hidden pb-2 pr-3 sm:table-cell"
                />
                <SortableHeaderCell
                  label="Best Energy"
                  column="bestEnergy"
                  sort={sort}
                  onClick={onSort}
                  align="right"
                  className="hidden pb-2 pr-3 md:table-cell"
                />
                <SortableHeaderCell
                  label="Share"
                  column="share"
                  sort={sort}
                  onClick={onSort}
                  className="w-28 pb-2 pr-1 sm:w-36"
                />
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => {
                const typeColor = SERIES_COLORS[entry.minerCategory];
                const minerColor = useMinerColors.getState().getColor(entry.minerId);
                return (
                  <tr
                    key={entry.minerId}
                    onClick={() => open(entry.minerId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open(entry.minerId);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`View node identity for ${displayNodeName(entry.minerId, nameOf(entry.minerId))}`}
                    className="group cursor-pointer border-t border-border transition-colors hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
                  >
                    <td className="py-2 pl-1 pr-2">
                      <RankBadge rank={entry.rank} />
                    </td>
                    <td className="py-2 pr-3">
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: minerColor }}
                        />
                        <span className="font-accent text-sm text-ink-strong" title={entry.minerId}>
                          {displayNodeName(entry.minerId, nameOf(entry.minerId))}
                        </span>
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className="inline-block px-1.5 py-0.5 font-accent text-[10px] font-bold uppercase tracking-wider"
                        style={{
                          color: typeColor,
                          backgroundColor: `${typeColor}18`,
                          border: `1px solid ${typeColor}33`,
                        }}
                      >
                        {entry.minerCategory}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-right font-heading text-sm text-ink-strong">
                      {formatNumber(entry.blockCount)}
                    </td>
                    {/* Metrics come from indexed wins; miners whose wins the
                        indexer hasn't decoded yet (backfill) have none. */}
                    <td className="hidden py-2 pr-3 text-right font-accent text-xs text-ink-subtle sm:table-cell">
                      {entry.avgMiningTime != null ? formatSeconds(entry.avgMiningTime) : "—"}
                    </td>
                    <td className="hidden py-2 pr-3 text-right font-accent text-xs text-ink-subtle md:table-cell">
                      {entry.bestEnergy != null ? formatEnergy(entry.bestEnergy) : "—"}
                    </td>
                    <td className="w-28 py-2 pr-1 sm:w-36">
                      <ShareBar share={entry.share} color={minerColor} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {modal}
    </div>
  );
}
