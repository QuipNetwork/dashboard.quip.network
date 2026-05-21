// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MinerStats } from "../../../types/telemetry";
import { formatNumber } from "../../../lib/format";
import { ChartCard } from "../../layout/ChartCard";
import { StatTile } from "./StatTile";

// The miner's /api/v1/stats reports cumulative counters for the local
// controller. These count work the miner did — NOT chain-canonical wins.
// "Problems Attempted" >= "Solutions Computed" >= chain-side "Problems Won"
// because most solutions submitted to chain lose the per-block energy race.
//
// The diagnostic strip below the primary tiles surfaces the pipeline stages
// (dispatch → submit → drop/error) so operators can spot stalls without
// shelling into the miner.
export function MinerStatsPanel({ stats }: { stats: MinerStats }) {
  const avgMiningTimeLabel = stats.avgMiningTime > 0 ? `${stats.avgMiningTime.toFixed(2)}s` : "—";
  return (
    <ChartCard
      title="Mining Performance"
      subtitle="Local controller counters from /api/v1/stats. Solutions Computed counts every result the miner produced; only the lowest-energy per block becomes a chain-side Problem Won."
    >
      <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
        <StatTile label="Problems Attempted" value={formatNumber(stats.totalBlocksAttempted)} />
        <StatTile
          label="Solutions Computed"
          value={formatNumber(stats.totalBlocksWon)}
          sublabel="meet on-chain difficulty"
        />
        <StatTile label="Submission Rate" value={`${(stats.winRate * 100).toFixed(2)}%`} />
        <StatTile label="Avg Mining Time" value={avgMiningTimeLabel} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-brand-gray-2 pt-4 sm:grid-cols-4">
        <StatTile label="Contexts Dispatched" value={formatNumber(stats.contextsDispatched)} />
        <StatTile label="Proofs Submitted" value={formatNumber(stats.proofsSubmitted)} />
        <StatTile label="Stale Drops" value={formatNumber(stats.staleDrops)} />
        <StatTile
          label="Submission Errors"
          value={formatNumber(stats.submissionErrors)}
          accent={stats.submissionErrors > 0 ? "#f87171" : undefined}
        />
      </div>
    </ChartCard>
  );
}
