// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";

import { formatDuration } from "@/lib/format";
import { formatBalance, formatNonce, shortAddress } from "@/lib/format-chain";
import { useTelemetryClient } from "@/services/telemetry-client";
import { computeChainHealth, type ChainHealth } from "@/lib/staleness";
import type { BlockRecord, IndexerObservability } from "@/types/telemetry";
import { FinalityBadge } from "@/components/blocks/FinalityBadge";
import { SearchInput } from "@/components/common/SearchInput";

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
        <p className="flex h-full items-center justify-center font-accent text-sm text-brand-gray-3">
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
          <p className="flex h-full items-center justify-center font-accent text-sm text-brand-gray-3">
            No solutions match “{query}”
          </p>
        ) : (
          <table className="w-full font-accent text-sm">
            <thead>
              <tr className="border-b border-brand-gray-2 text-left text-[10px] uppercase tracking-wider text-brand-gray-3">
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
                  className="cursor-pointer border-b border-brand-gray-1 transition-colors last:border-b-0 hover:bg-brand-gray-1/30"
                >
                  <td className="py-2 pr-4 font-mono text-brand-gray-5">
                    <span className="inline-flex items-center gap-1.5">
                      #{b.substrateBlockNumber}
                      <FinalityBadge block={b} />
                    </span>
                  </td>
                  <td className="py-2 pr-4 font-mono text-brand-gray-4">#{solutionNumber}</td>
                  <td className="py-2 pr-4 text-brand-gray-4" title={b.minerId}>
                    {shortAddress(b.minerId, 22, 4)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-brand-gray-5">
                    {b.energy.toFixed(1)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-brand-gray-4">
                    {b.difficultyEnergy.toFixed(1)}
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
        )}
        {canLoadMore && (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              data-testid="load-more"
              disabled={loadingOlder}
              onClick={loadMore}
              className="cursor-pointer rounded-md border border-brand-gray-2 px-3 py-1.5 font-accent text-xs uppercase tracking-wider text-brand-gray-3 transition-all hover:border-brand-gray-3 hover:text-brand-gray-5 disabled:cursor-default disabled:opacity-50"
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

// Centered overlay with a single solution's full detail. Closes on Escape,
// backdrop click, or the explicit close button.
function SolutionDetailsModal({
  block,
  solutionNumber,
  onClose,
}: {
  block: BlockRecord;
  solutionNumber: number;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const completedAt = new Date(block.timestamp * 1000).toISOString();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Solution #${solutionNumber} details`}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-8"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-lg border border-brand-gray-2 bg-brand-bg p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-accent text-lg text-brand-gray-5">Solution #{solutionNumber}</h2>
            <p className="font-accent text-xs text-brand-gray-3">
              Block #{block.substrateBlockNumber}{" "}
              {block.finalized ? "· finalized" : "· best (unfinalized)"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer rounded border border-brand-gray-2 px-2 py-0.5 font-accent text-xs text-brand-gray-3 hover:border-brand-gray-3 hover:text-brand-gray-5"
          >
            ×
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 font-accent text-sm">
          <Row
            label="Winner"
            value={shortAddress(block.minerId, 8, 6)}
            mono
            title={block.minerId}
          />
          <Row label="Energy" value={block.energy.toFixed(3)} />
          <Row label="Target Energy" value={block.difficultyEnergy.toFixed(3)} />
          <Row label="Diversity" value={block.diversity.toFixed(3)} />
          <Row label="Min Diversity" value={block.minDiversity.toFixed(3)} />
          <Row label="Solutions Found" value={String(block.numValidSolutions)} />
          <Row label="Min Solutions" value={String(block.minSolutions)} />
          <Row label="Time to Solution" value={formatDuration(block.miningTime * 1000)} />
          <Row label="Reward" value={formatBalance(block.reward)} />
          <Row label="Nodes" value={String(block.numNodes)} />
          <Row label="Edges" value={String(block.numEdges)} />
          <Row label="Completed At" value={completedAt} />
          <Row
            label="Substrate Block Hash"
            value={shortAddress(block.substrateBlockHash, 10, 8)}
            mono
            title={block.substrateBlockHash}
            span={2}
          />
          <Row
            label="Parent Hash"
            value={shortAddress(block.substrateParentHash, 10, 8)}
            mono
            title={block.substrateParentHash}
            span={2}
          />
          <Row
            label="Solution Hash"
            value={shortAddress(block.blockHash, 10, 8)}
            mono
            title={block.blockHash}
            span={2}
          />
          <Row label="Nonce" value={formatNonce(block.nonce)} mono title={block.nonce} span={2} />
        </dl>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
  title,
  span = 1,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
  span?: 1 | 2;
}) {
  return (
    <div className={span === 2 ? "col-span-2" : ""}>
      <dt className="text-[10px] uppercase tracking-wider text-brand-gray-3">{label}</dt>
      <dd
        title={title}
        className={`tabular-nums text-brand-gray-5 ${mono ? "break-all font-mono text-xs" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}
