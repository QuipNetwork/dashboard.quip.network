// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChartCard } from "../../layout/ChartCard";
import { formatDuration, formatNumber } from "../../../lib/format";
import { SERIES_COLORS } from "../../../lib/colors";
import { useMyNode } from "./use-my-node";
import { NeighborsList } from "./NeighborsList";
import { StatTile } from "./StatTile";

export function MyNodeView() {
  const stats = useMyNode();

  if (!stats.selfAddress) {
    return (
      <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-12 text-center backdrop-blur-xl">
        <p className="font-heading text-2xl text-brand-gray-5">Connecting to node…</p>
        <p className="mt-2 font-accent text-sm text-brand-gray-3">
          The indexer hasn't matched the dashboard's configured node to the peer list yet.
        </p>
      </div>
    );
  }

  if (!stats.node) {
    return (
      <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-12 text-center backdrop-blur-xl">
        <p className="font-heading text-2xl text-brand-gray-5">Node not in snapshot</p>
        <p className="mt-2 font-accent text-sm text-brand-gray-3">
          Self address <code>{stats.selfAddress}</code> is registered but missing from the latest
          nodes snapshot.
        </p>
      </div>
    );
  }

  const { node, entry, rank, totalMiners, blocksMined, uptimeMs, neighbors } = stats;
  const nodeLabel = node.nodeName ?? node.publicHost ?? node.address.slice(0, 16);
  const typeColor = entry ? SERIES_COLORS[entry.minerCategory] : "#67E347";

  return (
    <>
      <div className="mb-5 flex flex-col gap-1 rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-5 backdrop-blur-xl sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <p className="font-accent text-[10px] uppercase tracking-wider text-brand-gray-3">
            Connected Node
          </p>
          <h2 className="font-heading text-2xl text-brand-gray-6">{nodeLabel}</h2>
          <p className="mt-1 font-accent text-xs text-brand-gray-3">
            <span className="text-brand-gray-4">{node.address}</span>
            {node.publicHost && <span className="ml-2">· {node.publicHost}</span>}
            {node.status && <span className="ml-2">· {node.status}</span>}
          </p>
        </div>
        {node.runtime?.quipVersion && (
          <span className="inline-block rounded-md border border-brand-gray-2 px-2 py-1 font-accent text-xs text-brand-gray-4">
            quip {node.runtime.quipVersion}
          </span>
        )}
      </div>

      <div className="mb-5 grid grid-cols-1 gap-5 sm:grid-cols-3">
        <StatTile
          label="Blocks Mined"
          value={formatNumber(blocksMined)}
          sublabel={entry ? `Primary miner: ${entry.minerId}` : "Awaiting block data"}
          accent={typeColor}
        />
        <StatTile
          label="Time on Network"
          value={uptimeMs != null ? formatDuration(uptimeMs) : "—"}
          sublabel={
            node.firstSeen > 0
              ? `Since ${new Date(node.firstSeen * 1000).toLocaleDateString()}`
              : undefined
          }
        />
        <StatTile
          label="Network Rank"
          value={rank != null ? `#${rank}` : "—"}
          sublabel={
            rank != null && totalMiners > 0 ? `of ${totalMiners} miners` : "No blocks mined yet"
          }
        />
      </div>

      <ChartCard title="Rank-Adjacent Miners" subtitle="Your position in the network leaderboard">
        <NeighborsList self={entry} neighbors={neighbors} />
      </ChartCard>
    </>
  );
}
