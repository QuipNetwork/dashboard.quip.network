// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";

import { displayNodeName, formatBalance } from "@/lib/format-chain";
import { formatDuration } from "@/lib/format";
import { useTelemetryStore } from "@/store/telemetry-store";
import type { ChainMinerRecord, NodeDescriptorRecord } from "@quip/shared/telemetry";
import { SearchInput } from "@/components/common/SearchInput";
import { NodeIdentityModal } from "@/components/common/NodeIdentityModal";

export function filterChainMiners(
  miners: readonly ChainMinerRecord[],
  descriptorsByAccount: ReadonlyMap<string, NodeDescriptorRecord>,
  query: string,
): ChainMinerRecord[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...miners];
  return miners.filter((m) => {
    const d = descriptorsByAccount.get(m.accountId);
    return (
      m.accountId.toLowerCase().includes(q) ||
      (d?.descriptor.nodeName?.toLowerCase().includes(q) ?? false) ||
      (d?.descriptor.runtime?.quipVersion?.toLowerCase().includes(q) ?? false)
    );
  });
}

/**
 * On-chain miner table from `quantum_pow.Miners` storage. The cleanest
 * authoritative view of who's actually mining — distinct from the
 * telemetry-snapshot "nodes" list which is operator self-reported and
 * may include nodes that never submitted a successful proof.
 *
 * Lives here for historical reasons (extracted from the original
 * `ChainMinersView` wrapper); embedded by `ComputeAvailableView` since
 * v0.3. The Chain tab itself now renders the validator-centric
 * `ChainView` from `./ChainView`.
 */
export function ChainMinersTable() {
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const blocks = useTelemetryStore((s) => s.blocks);
  const nodes = useTelemetryStore((s) => s.nodes);
  const [query, setQuery] = useState("");
  const [openAccountId, setOpenAccountId] = useState<string | null>(null);

  // Index descriptors by accountId so the per-row join is O(1). useMemo
  // keeps the map stable across renders that don't change descriptors.
  const descriptorsByAccount = useMemo(() => {
    return new Map(nodeDescriptors.map((d) => [d.accountId, d]));
  }, [nodeDescriptors]);

  // Last participation = most recent qblock this account won (block.minerId
  // match). One pass over the rolling blocks window; blocks arrive DESC by
  // height but timestamps can tie, so we keep the max explicitly.
  const lastWonByAccount = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of blocks) {
      const prev = map.get(b.minerId);
      if (prev == null || b.timestamp > prev) map.set(b.minerId, b.timestamp);
    }
    return map;
  }, [blocks]);

  const filtered = filterChainMiners(chainMiners, descriptorsByAccount, query);
  const now = Date.now();

  // Relative "last participation": most recent win, else the descriptor's
  // last-update timestamp, else nothing.
  const participationLabel = (m: ChainMinerRecord): string => {
    const won = lastWonByAccount.get(m.accountId);
    const fallback = descriptorsByAccount.get(m.accountId)?.blockTimestamp;
    const tsSec = won ?? fallback;
    if (tsSec == null) return "—";
    return `${formatDuration(now - tsSec * 1000)} ago`;
  };

  const openMiner = openAccountId
    ? chainMiners.find((m) => m.accountId === openAccountId)
    : undefined;
  const openRecord = openAccountId ? descriptorsByAccount.get(openAccountId) : undefined;
  const openNode =
    openMiner?.telemetryNodeAddress != null
      ? nodes?.nodes[openMiner.telemetryNodeAddress]
      : undefined;

  return (
    <div className="border border-border bg-white">
      <header className="border-b border-border px-4 py-3">
        <h2 className="font-heading text-lg text-ink-strong">
          On-chain miners ({chainMiners.length})
        </h2>
        <p className="mt-1 font-accent text-xs text-ink-subtle">
          From <code>quantum_pow.Miners</code> storage. Sorted by lifetime rewards. Identity columns
          (rig name, version) joined from <code>MinerRegistry.NodeDescriptors</code>. Click a row
          for full node identity.
        </p>
      </header>
      {chainMiners.length === 0 ? (
        <p className="px-4 py-6 text-center font-accent text-sm text-ink-subtle">
          No miners registered on chain yet.
        </p>
      ) : (
        <>
          <div className="border-b border-border px-4 py-3">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search by account, rig name, or version…"
            />
          </div>
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center font-accent text-sm text-ink-subtle">
              No miners match “{query}”
            </p>
          ) : (
            <div className="max-h-[32rem] overflow-auto">
              <table className="w-full font-accent text-sm">
                <thead className="sticky top-0 bg-white text-left text-xs uppercase tracking-wider text-ink-subtle">
                  <tr className="border-b border-border">
                    <th className="px-4 py-2">Miner</th>
                    <th className="px-4 py-2">Version</th>
                    <th className="px-4 py-2 text-right">Deposit</th>
                    <th className="px-4 py-2 text-right">Proofs Submitted</th>
                    <th className="px-4 py-2 text-right">Proofs Won</th>
                    <th className="px-4 py-2 text-right">Rewards</th>
                    <th className="px-4 py-2 text-right">Last participation</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m) => {
                    const d = descriptorsByAccount.get(m.accountId);
                    return (
                      <tr
                        key={m.accountId}
                        onClick={() => setOpenAccountId(m.accountId)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setOpenAccountId(m.accountId);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label={`View node identity for ${displayNodeName(
                          m.accountId,
                          d?.descriptor.nodeName,
                        )}`}
                        className="cursor-pointer border-b border-border last:border-b-0 hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
                      >
                        <td
                          className="px-4 py-2 text-ink-strong underline-offset-2 hover:underline"
                          title={m.accountId}
                        >
                          {displayNodeName(m.accountId, d?.descriptor.nodeName)}
                        </td>
                        <td className="px-4 py-2 text-ink-subtle">
                          {d?.descriptor.runtime?.quipVersion ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {formatBalance(m.deposit)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{m.proofsSubmitted}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{m.proofsWon}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {formatBalance(m.rewardsEarned)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-ink-subtle">
                          {participationLabel(m)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {openAccountId && (
        <NodeIdentityModal
          accountId={openAccountId}
          record={openRecord}
          miner={openMiner}
          node={openNode}
          onClose={() => setOpenAccountId(null)}
        />
      )}
    </div>
  );
}
