// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ChainMinerRecord, MinerStats } from "../../../types/telemetry";
import { formatNumber } from "../../../lib/format";
import { ChartCard } from "../../layout/ChartCard";
import { StatTile } from "./StatTile";

// The miner's /api/v1/stats reports cumulative controller counters. The
// top row reframes them as local aggregates; the bottom row exposes the
// raw pipeline stages so operators can spot stalls without shelling into
// the miner.
//
// "Problems Attempted" = contexts_dispatched (every problem the controller
// queued), "Solutions Computed" = proofs_submitted (eligible solutions sent
// to chain). Submission Rate is the local ratio between them. Avg Mining
// Time is computed dashboard-side from self's chain blocks since /api/v1/stats
// no longer publishes a precomputed average.
export function MinerStatsPanel({
  stats,
  chainMinerEntry,
  selfAvgMiningTimeSec,
}: {
  stats: MinerStats;
  chainMinerEntry: ChainMinerRecord | null;
  selfAvgMiningTimeSec: number | null;
}) {
  const avgMiningTimeLabel =
    selfAvgMiningTimeSec != null && selfAvgMiningTimeSec > 0
      ? `${selfAvgMiningTimeSec.toFixed(2)}s`
      : "—";
  // Submission Rate = solutions the miner submitted / problems it attempted.
  // Distinct from Chain Acceptance below (proofs_won / proofs_submitted,
  // chain-side), which measures how many of those submissions actually won
  // their block.
  const submissionRateLabel =
    stats.contextsDispatched > 0
      ? `${((stats.proofsSubmitted / stats.contextsDispatched) * 100).toFixed(2)}%`
      : "—";
  // Chain Acceptance = chain-recorded proofs / proofs the miner submitted.
  // Sourced from `quantumPow.Miners[self]` so it reflects what the pallet
  // actually persisted, not what the miner thought it sent.
  const chainSubmitted = chainMinerEntry ? Number(chainMinerEntry.proofsSubmitted) : 0;
  const chainWon = chainMinerEntry ? Number(chainMinerEntry.proofsWon) : 0;
  const chainAcceptanceLabel =
    chainMinerEntry && chainSubmitted > 0
      ? `${((chainWon / chainSubmitted) * 100).toFixed(2)}%`
      : "—";
  return (
    <ChartCard
      title="Mining Performance"
      subtitle="Local controller counters from /api/v1/stats. Chain accepts at most 8 proofs per block (MaxProofsPerBlock); excess submissions return txpool code 1016. Only the lowest-energy proof per block becomes a chain-side Problem Won."
    >
      <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
        <StatTile label="Problems Attempted" value={formatNumber(stats.contextsDispatched)} />
        <StatTile
          label="Solutions Computed"
          value={formatNumber(stats.proofsSubmitted)}
          sublabel="meet on-chain difficulty"
        />
        <StatTile label="Submission Rate" value={submissionRateLabel} sublabel="local" />
        <StatTile
          label="Avg Mining Time"
          value={avgMiningTimeLabel}
          sublabel={selfAvgMiningTimeSec != null ? "across recent self-wins" : undefined}
        />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-brand-gray-2 pt-4 sm:grid-cols-5">
        <StatTile
          label="Chain Acceptance"
          value={chainAcceptanceLabel}
          sublabel="won / submitted"
        />
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
