// SPDX-License-Identifier: AGPL-3.0-or-later

import { SERIES_COLORS } from "../../../lib/colors";
import { formatDuration } from "../../../lib/format";
import { computeChainHealth, type ChainHealth } from "../../../lib/staleness";
import type { BlockRecord, IndexerObservability } from "../../../types/telemetry";
import { FinalityBadge } from "../../blocks/FinalityBadge";

interface RecentBlocksTableProps {
  blocks: BlockRecord[];
  indexer?: IndexerObservability | null;
  limit?: number;
}

const DEFAULT_LIMIT = 10;

// Renders the most recent N completed blocks with their winner, solved
// energy, mining time, and time-since-completion. `blocks` is expected in
// ascending order (tip last) — matching how the store ships it.
export function RecentBlocksTable({
  blocks,
  indexer = null,
  limit = DEFAULT_LIMIT,
}: RecentBlocksTableProps) {
  const now = Date.now();
  const recent = blocks.slice(-limit).reverse();
  const tip = blocks.length > 0 ? (blocks[blocks.length - 1] ?? null) : null;
  const health = computeChainHealth({
    nowMs: now,
    tipBlockTimestampMs: tip ? tip.timestamp * 1000 : null,
    indexer,
  });

  if (recent.length === 0) {
    return (
      <p className="flex h-full items-center justify-center font-accent text-sm text-brand-gray-3">
        No blocks yet
      </p>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <HealthBanner health={health} />
      <table className="w-full font-accent text-sm">
        <thead>
          <tr className="border-b border-brand-gray-2 text-left text-[10px] uppercase tracking-wider text-brand-gray-3">
            <th className="pb-2 pr-4">Block</th>
            <th className="pb-2 pr-4">Winner</th>
            <th className="pb-2 pr-4">Type</th>
            <th className="pb-2 pr-4 text-right">Energy</th>
            <th className="pb-2 pr-4 text-right">Mining Time</th>
            <th className="pb-2 text-right">When</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((b) => {
            const color = SERIES_COLORS[b.minerCategory];
            return (
              <tr
                key={`${b.epoch}:${b.blockIndex}`}
                className="border-b border-brand-gray-1 last:border-b-0"
              >
                <td className="py-2 pr-4 font-mono text-brand-gray-5">
                  <span className="inline-flex items-center gap-1.5">
                    #{b.blockIndex}
                    <FinalityBadge block={b} />
                  </span>
                </td>
                <td className="py-2 pr-4 text-brand-gray-4" title={b.minerId}>
                  {truncateMinerId(b.minerId)}
                </td>
                <td className="py-2 pr-4">
                  <span
                    className="inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-accent text-xs"
                    style={{
                      borderColor: `${color}55`,
                      backgroundColor: `${color}15`,
                      color,
                    }}
                  >
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    {b.minerCategory}
                  </span>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-brand-gray-5">
                  {b.energy.toFixed(1)}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-brand-gray-4">
                  {formatDuration(b.miningTime * 1000)}
                </td>
                <td className="py-2 text-right tabular-nums text-brand-gray-3">
                  {formatDuration(now - b.timestamp * 1000)} ago
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Keep the table compact while preserving enough of the minerId to be
// recognizable. Full id lives in the cell's `title` for hover disclosure.
function truncateMinerId(id: string): string {
  if (id.length <= 28) return id;
  return `${id.slice(0, 22)}…${id.slice(-4)}`;
}

// Inline banner that surfaces the three-state health from computeChainHealth.
// "healthy" renders nothing so the feed stays compact during normal operation.
// Tailwind color tokens are chosen for semantic match with existing usage
// (amber-ish = warning, red-ish = error) without introducing new palette keys.
function HealthBanner({ health }: { health: ChainHealth }) {
  if (health.level === "healthy") return null;
  const isStalled = health.level === "stalled";
  return (
    <div
      role="status"
      className={
        isStalled
          ? "mb-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 font-accent text-xs text-red-300"
          : "mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 font-accent text-xs text-amber-200"
      }
    >
      <span className="mr-1.5" aria-hidden="true">
        {isStalled ? "■" : "▲"}
      </span>
      {health.reason}
    </div>
  );
}
