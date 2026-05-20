// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MinerStats } from "../../../types/telemetry";
import { formatNumber } from "../../../lib/format";
import { ChartCard } from "../../layout/ChartCard";
import { StatTile } from "./StatTile";

export function MinerStatsPanel({ stats }: { stats: MinerStats }) {
  return (
    <ChartCard
      title="Mining Performance"
      subtitle="Aggregate counters from this node's /api/v1/stats"
    >
      <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
        <StatTile label="Blocks Attempted" value={formatNumber(stats.totalBlocksAttempted)} />
        <StatTile label="Blocks Won" value={formatNumber(stats.totalBlocksWon)} />
        <StatTile label="Win Rate" value={`${(stats.winRate * 100).toFixed(2)}%`} />
        <StatTile label="Avg Mining Time" value={`${stats.avgMiningTime.toFixed(2)}s`} />
        <StatTile label="Heads Observed" value={formatNumber(stats.headsObserved)} />
        <StatTile label="Contexts Dispatched" value={formatNumber(stats.contextsDispatched)} />
        <StatTile label="Proofs Submitted" value={formatNumber(stats.proofsSubmitted)} />
        <StatTile
          label="Submission Errors"
          value={formatNumber(stats.submissionErrors)}
          accent={stats.submissionErrors > 0 ? "#f87171" : undefined}
        />
      </div>
    </ChartCard>
  );
}
