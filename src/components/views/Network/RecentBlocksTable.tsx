// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";

import { formatDuration } from "../../../lib/format";
import { formatBalance } from "../../../lib/format-chain";
import { computeChainHealth, type ChainHealth } from "../../../lib/staleness";
import type { BlockRecord, IndexerObservability } from "../../../types/telemetry";
import { FinalityBadge } from "../../blocks/FinalityBadge";

interface RecentBlocksTableProps {
  blocks: BlockRecord[];
  indexer?: IndexerObservability | null;
}

// Client-side pagination page size. The telemetry store already caps the
// rolling window at 500 blocks (Phase 0.7), so slicing in JS is cheap; the
// server-side `getRecentBlocks(limit, offset)` endpoint is plumbed and ready
// for a future "infinite scroll" upgrade.
const PAGE_SIZE = 100;

// Renders the most recent completed blocks with their winner, solved energy,
// mining time, reward, and time-since-completion. `blocks` is expected in
// descending order (tip first) — matching how the store ships it.
export function RecentBlocksTable({ blocks, indexer = null }: RecentBlocksTableProps) {
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE);
  const now = Date.now();
  const tip = blocks.length > 0 ? (blocks[0] ?? null) : null;
  const health = computeChainHealth({
    nowMs: now,
    tipBlockTimestampMs: tip ? tip.timestamp * 1000 : null,
    indexer,
  });

  if (blocks.length === 0) {
    return (
      <>
        <HealthBanner health={health} />
        <p className="flex h-full items-center justify-center font-accent text-sm text-brand-gray-3">
          No solutions yet
        </p>
      </>
    );
  }

  const visibleBlocks = blocks.slice(0, pageSize);
  const canLoadMore = pageSize < blocks.length;
  const remaining = blocks.length - pageSize;

  return (
    <div className="h-full overflow-auto">
      <HealthBanner health={health} />
      <table className="w-full font-accent text-sm">
        <thead>
          <tr className="border-b border-brand-gray-2 text-left text-[10px] uppercase tracking-wider text-brand-gray-3">
            <th className="pb-2 pr-4">Block</th>
            <th className="pb-2 pr-4">Winner</th>
            <th className="pb-2 pr-4 text-right">Energy</th>
            <th className="pb-2 pr-4 text-right">Diversity</th>
            <th className="pb-2 pr-4 text-right">Mining Time</th>
            <th className="pb-2 pr-4 text-right">Reward</th>
            <th className="pb-2 text-right">When</th>
          </tr>
        </thead>
        <tbody>
          {visibleBlocks.map((b) => (
            <tr key={b.blockHash} className="border-b border-brand-gray-1 last:border-b-0">
              <td className="py-2 pr-4 font-mono text-brand-gray-5">
                <span className="inline-flex items-center gap-1.5">
                  #{b.substrateBlockNumber}
                  <FinalityBadge block={b} />
                </span>
              </td>
              <td className="py-2 pr-4 text-brand-gray-4" title={b.minerId}>
                {truncateMinerId(b.minerId)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-brand-gray-5">
                {b.energy.toFixed(1)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-brand-gray-4">
                {b.diversity.toFixed(3)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-brand-gray-4">
                {formatDuration(b.miningTime * 1000)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-brand-gray-5">
                {formatBalance(b.reward)}
              </td>
              <td className="py-2 text-right tabular-nums text-brand-gray-3">
                {formatDuration(now - b.timestamp * 1000)} ago
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canLoadMore && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            data-testid="load-more"
            onClick={() => setPageSize((s) => Math.min(s + PAGE_SIZE, blocks.length))}
            className="cursor-pointer rounded-md border border-brand-gray-2 px-3 py-1.5 font-accent text-xs uppercase tracking-wider text-brand-gray-3 transition-all hover:border-brand-gray-3 hover:text-brand-gray-5"
          >
            Load more ({remaining} remaining)
          </button>
        </div>
      )}
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
