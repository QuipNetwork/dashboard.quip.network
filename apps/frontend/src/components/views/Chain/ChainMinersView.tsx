// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";

import { displayNodeName, formatBalance } from "@/lib/format-chain";
import { formatDuration } from "@/lib/format";
import { useTelemetryStore } from "@/store/telemetry-store";
import type { ChainMinerRecord, NodeDescriptorRecord } from "@quip/shared/telemetry";
import { SearchInput } from "@/components/common/SearchInput";
import { SortableHeaderCell } from "@/components/common/SortableHeaderCell";
import { useNodeIdentityModal } from "@/components/common/use-node-identity-modal";
import { FOURTEEN_DAYS_MS } from "@/components/views/ComputeAvailable/use-compute-available";
import { useChainMinerSort, type MinerSortKeys } from "./use-chain-miner-sort";

/**
 * Whether an on-chain miner should be pruned from the table: it has never won
 * a qblock (`proofsWon === "0"`) AND its last participation is known to be
 * older than two weeks (bead 1o0.4). `participationTsSec` is the account's most
 * recent win, else its descriptor's last-update time (Unix seconds), else null.
 * A null timestamp means activity is unknown — we cannot prove staleness, so
 * the miner is kept rather than hidden from the authoritative on-chain list.
 */
export function isStaleNeverMiner(
  miner: ChainMinerRecord,
  participationTsSec: number | null,
  nowMs: number,
): boolean {
  if (miner.proofsWon !== "0") return false;
  if (participationTsSec == null) return false;
  return nowMs - participationTsSec * 1000 > FOURTEEN_DAYS_MS;
}

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
 * `ChainMinersView` wrapper); embedded by `NetworkView` (the node
 * inventory tab — see docs/ui-layout.md). The Chain tab itself renders
 * the validator-centric `ChainView` from `./ChainView`.
 */
export function ChainMinersTable() {
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const blocks = useTelemetryStore((s) => s.blocks);
  const [query, setQuery] = useState("");
  // Shared identity dialog: resolves the descriptor/miner/live node for an
  // account and wires the "More info →" link to the node detail page. Same
  // wiring the Leaderboard and NeighborsList use.
  const { open, modal } = useNodeIdentityModal();

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

  // Per-account lookups shared by the sorter and the cells, so clicking a
  // header orders by exactly what the column displays. Participation =
  // most recent win, else the descriptor's last-update timestamp.
  const sortKeys = useMemo<MinerSortKeys>(
    () => ({
      nameFor: (accountId) =>
        displayNodeName(accountId, descriptorsByAccount.get(accountId)?.descriptor.nodeName),
      versionFor: (accountId) =>
        descriptorsByAccount.get(accountId)?.descriptor.runtime?.quipVersion ?? null,
      participationTsFor: (accountId) =>
        lastWonByAccount.get(accountId) ??
        descriptorsByAccount.get(accountId)?.blockTimestamp ??
        null,
    }),
    [descriptorsByAccount, lastWonByAccount],
  );

  const now = Date.now();
  // Prune abandoned registrations: zero-win miners idle 2+ weeks (bead 1o0.4).
  // The hidden count is disclosed in the header so the list stays honest.
  const visibleMiners = chainMiners.filter(
    (m) => !isStaleNeverMiner(m, sortKeys.participationTsFor(m.accountId), now),
  );
  const hiddenCount = chainMiners.length - visibleMiners.length;
  const filtered = filterChainMiners(visibleMiners, descriptorsByAccount, query);
  const { sorted, sort, onSort } = useChainMinerSort(filtered, sortKeys);

  const participationLabel = (m: ChainMinerRecord): string => {
    const tsSec = sortKeys.participationTsFor(m.accountId);
    if (tsSec == null) return "—";
    return `${formatDuration(now - tsSec * 1000)} ago`;
  };

  return (
    <div className="border border-border bg-white">
      <header className="border-b border-border px-4 py-3">
        <h2 className="font-heading text-lg text-ink-strong">
          On-chain miners ({visibleMiners.length})
        </h2>
        <p className="mt-1 font-accent text-xs text-ink-subtle">
          From <code>quantum_pow.Miners</code> storage. Click a column header to sort. Identity
          columns (rig name, version) joined from <code>MinerRegistry.NodeDescriptors</code>. Click
          a row for full node identity.
          {hiddenCount > 0 && (
            <>
              {" "}
              {hiddenCount} inactive never-miner{hiddenCount === 1 ? "" : "s"} (idle 2+ weeks, no
              wins) hidden.
            </>
          )}
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
                    <SortableHeaderCell label="Miner" column="miner" sort={sort} onClick={onSort} />
                    <SortableHeaderCell
                      label="Version"
                      column="version"
                      sort={sort}
                      onClick={onSort}
                    />
                    <SortableHeaderCell
                      label="Deposit"
                      column="deposit"
                      sort={sort}
                      onClick={onSort}
                      align="right"
                    />
                    <SortableHeaderCell
                      label="Proofs Submitted"
                      column="proofsSubmitted"
                      sort={sort}
                      onClick={onSort}
                      align="right"
                    />
                    <SortableHeaderCell
                      label="Proofs Won"
                      column="proofsWon"
                      sort={sort}
                      onClick={onSort}
                      align="right"
                    />
                    <SortableHeaderCell
                      label="Rewards"
                      column="rewards"
                      sort={sort}
                      onClick={onSort}
                      align="right"
                    />
                    <SortableHeaderCell
                      label="Last participation"
                      column="lastParticipation"
                      sort={sort}
                      onClick={onSort}
                      align="right"
                    />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((m) => {
                    const d = descriptorsByAccount.get(m.accountId);
                    return (
                      <tr
                        key={m.accountId}
                        onClick={() => open(m.accountId)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            open(m.accountId);
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
      {modal}
    </div>
  );
}
