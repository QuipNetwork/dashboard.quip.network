// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";

import { formatDuration } from "@/lib/format";
import { formatBalance, shortAddress } from "@/lib/format-chain";
import { useTelemetryClient } from "@/services/telemetry-client";
import { computeChainHealth } from "@/lib/staleness";
import type { BlockRecord, IndexerObservability } from "@/types/telemetry";
import { FinalityBadge } from "@/components/blocks/FinalityBadge";
import { SearchInput } from "@/components/common/SearchInput";
import { HealthBanner } from "./HealthBanner";
import { SolutionDetailsModal } from "./SolutionDetailsModal";

export interface NumberedBlock {
  block: BlockRecord;
  solutionNumber: number;
}

export function filterRecentBlocks(rows: readonly NumberedBlock[], query: string): NumberedBlock[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(
    ({ block, solutionNumber }) =>
      block.minerId.toLowerCase().includes(q) ||
      block.substrateBlockNumber.toLowerCase().includes(q) ||
      String(solutionNumber).includes(q),
  );
}

interface RecentBlocksTableProps {
  blocks: BlockRecord[];
  indexer?: IndexerObservability | null;
  // Chain-wide total of accepted PoW proofs (sum of
  // `chainMiners[].proofsWon`). The tip row is solution #totalProofsWon,
  // each row below decrements by one. When omitted (e.g., legacy callers
  // and unit tests), Solution# falls back to indexing from `blocks.length`,
  // which is accurate after a fresh wipe-on-drift but undercounts when
  // older proofs predate the current `blocks` window.
  totalProofsWon?: number;
}

// Client-side pagination page size. The telemetry store already caps the
// rolling window at 500 blocks (Phase 0.7), so slicing in JS is cheap; the
// server-side `getRecentBlocks(limit, offset)` endpoint is plumbed and ready
// for a future "infinite scroll" upgrade.
const PAGE_SIZE = 100;
const LIVE_WINDOW = 500;

// Renders the most recent solutions (one per chain block) with click-to-open
// detail modal. `blocks` is expected in descending order (tip first) —
// matching how the store ships it.
export function RecentBlocksTable({
  blocks,
  indexer = null,
  totalProofsWon,
}: RecentBlocksTableProps) {
  const client = useTelemetryClient();
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE);
  const [query, setQuery] = useState<string>("");
  const [older, setOlder] = useState<BlockRecord[]>([]);
  const [loadingOlder, setLoadingOlder] = useState<boolean>(false);
  const [serverExhausted, setServerExhausted] = useState<boolean>(false);
  const [selectedBlock, setSelectedBlock] = useState<{
    block: BlockRecord;
    solutionNumber: number;
  } | null>(null);

  const tipHash = blocks[0]?.blockHash;
  useEffect(() => {
    setOlder([]);
    setServerExhausted(false);
  }, [tipHash]);

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
        <p className="flex h-full items-center justify-center font-accent text-sm text-ink-subtle">
          No solutions yet
        </p>
      </>
    );
  }

  // blocks is DESC by substrateBlockNumber, so blocks[0] is the most recent
  // winning solution. Solution numbering walks down from totalProofsWon —
  // computed from the full-list index so search doesn't perturb it.
  const tipSolutionNumber = totalProofsWon ?? blocks.length;
  const loaded = [...blocks, ...older];
  const numbered: NumberedBlock[] = loaded.map((block, i) => ({
    block,
    solutionNumber: tipSolutionNumber - i,
  }));
  const matched = filterRecentBlocks(numbered, query);
  const visible = matched.slice(0, pageSize);
  const hasMoreInMemory = pageSize < matched.length;
  const canFetchOlder = !query && !serverExhausted && blocks.length >= LIVE_WINDOW;
  const canLoadMore = hasMoreInMemory || canFetchOlder;
  const remaining = matched.length - pageSize;

  async function loadMore() {
    if (hasMoreInMemory) {
      setPageSize((s) => s + PAGE_SIZE);
      return;
    }
    if (!canFetchOlder || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await client.fetchBlocks(PAGE_SIZE, blocks.length + older.length);
      if (page.length < PAGE_SIZE) setServerExhausted(true);
      if (page.length > 0) {
        setOlder((prev) => [...prev, ...page]);
        setPageSize((s) => s + PAGE_SIZE);
      }
    } catch {
      setServerExhausted(false);
    } finally {
      setLoadingOlder(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <HealthBanner health={health} />
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder="Search by winner, block, or solution #…"
      />
      <div className="flex-1 overflow-auto">
        {visible.length === 0 ? (
          <p className="flex h-full items-center justify-center font-accent text-sm text-ink-subtle">
            No solutions match “{query}”
          </p>
        ) : (
          <table className="w-full font-accent text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-ink-subtle">
                <th className="pb-2 pr-4">Block</th>
                <th className="pb-2 pr-4">Solution#</th>
                <th className="pb-2 pr-4">Winner</th>
                <th className="pb-2 pr-4 text-right">Energy</th>
                <th className="pb-2 pr-4 text-right">Target Energy</th>
                <th className="pb-2 pr-4 text-right">Time to Solution</th>
                <th className="pb-2 pr-4 text-right">Reward</th>
                <th className="pb-2 text-right">When</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ block: b, solutionNumber }) => (
                <tr
                  key={b.blockHash}
                  onClick={() => setSelectedBlock({ block: b, solutionNumber })}
                  className="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-surface-1"
                >
                  <td className="py-2 pr-4 font-mono text-ink-strong">
                    <span className="inline-flex items-center gap-1.5">
                      #{b.substrateBlockNumber}
                      <FinalityBadge block={b} />
                    </span>
                  </td>
                  <td className="py-2 pr-4 font-mono text-ink-body">#{solutionNumber}</td>
                  <td className="py-2 pr-4 text-ink-body" title={b.minerId}>
                    {shortAddress(b.minerId, 22, 4)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-ink-strong">
                    {b.energy.toFixed(1)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-ink-body">
                    {b.difficultyEnergy.toFixed(1)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-ink-body">
                    {formatDuration(b.miningTime * 1000)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-ink-strong">
                    {formatBalance(b.reward)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-ink-subtle">
                    {formatDuration(now - b.timestamp * 1000)} ago
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canLoadMore && (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              data-testid="load-more"
              disabled={loadingOlder}
              onClick={loadMore}
              className="cursor-pointer border border-border px-3 py-1.5 font-accent text-xs uppercase tracking-wider text-ink-subtle transition-all hover:border-border-strong hover:text-ink-strong disabled:cursor-default disabled:opacity-50"
            >
              {loadingOlder
                ? "Loading…"
                : hasMoreInMemory
                  ? `Load more (${remaining} remaining)`
                  : "Load older solutions"}
            </button>
          </div>
        )}
      </div>
      {selectedBlock && (
        <SolutionDetailsModal
          block={selectedBlock.block}
          solutionNumber={selectedBlock.solutionNumber}
          onClose={() => setSelectedBlock(null)}
        />
      )}
    </div>
  );
}
