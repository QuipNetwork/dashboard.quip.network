// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ChainMinerRecord, MinerStats, ModeBreakdown } from "../../../types/telemetry";
import { formatDuration, formatNumber } from "../../../lib/format";
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
  problemsAttempted,
  modes,
  dataAgeMs,
}: {
  stats: MinerStats;
  chainMinerEntry: ChainMinerRecord | null;
  selfAvgMiningTimeSec: number | null;
  // Lifetime count of distinct solution_numbers the indexer has recorded
  // iterations for. Distinct from `stats.contextsDispatched`, which
  // counts dispatches and can exceed problems when the controller
  // refreshes mid-mine.
  problemsAttempted: number;
  // Per-backend breakdown — when present (multi-process container),
  // a Backends row appears under the headline counters showing each
  // mode's contribution. Undefined / empty hides the row entirely so
  // single-process miners see the same UI as before.
  modes?: Record<string, ModeBreakdown>;
  // Age of the indexer's last /api/v1/status fetch (ms), measured
  // against the server-stamped `serverTime` anchor. Null when the
  // indexer hasn't completed a poll yet (fresh deploy) — the footer
  // hides in that case. Anchored on server time so a backgrounded
  // tab's drifted clock doesn't inflate the displayed age (audit fix
  // #3).
  dataAgeMs?: number | null;
}) {
  const avgMiningTimeLabel =
    selfAvgMiningTimeSec != null && selfAvgMiningTimeSec > 0
      ? `${selfAvgMiningTimeSec.toFixed(2)}s`
      : "—";
  // Submission Rate = solutions the miner submitted / distinct problems it
  // attempted. Distinct from Chain Acceptance below (proofs_won /
  // proofs_submitted, chain-side), which measures how many of those
  // submissions actually won their block.
  const submissionRateLabel =
    problemsAttempted > 0
      ? `${((stats.proofsSubmitted / problemsAttempted) * 100).toFixed(2)}%`
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
        <StatTile label="Problems Attempted" value={formatNumber(problemsAttempted)} />
        <StatTile
          label="Solutions Computed"
          value={formatNumber(stats.proofsSubmitted)}
          sublabel={
            <>
              meet on-chain difficulty
              <span className="mt-0.5 block text-brand-gray-4">
                {formatNumber(stats.resultsReceived)} results
                {stats.duplicateResultDrops > 0
                  ? ` · ${formatNumber(stats.duplicateResultDrops)} dedup'd`
                  : ""}
              </span>
            </>
          }
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
      <ModesBreakdownRow modes={modes} />
      {dataAgeMs != null && (
        <p className="mt-4 text-right font-accent text-[10px] uppercase tracking-wider text-brand-gray-3">
          fetched {formatDuration(dataAgeMs)} ago
        </p>
      )}
    </ChartCard>
  );
}

// Per-backend breakdown for multi-process containers. Renders one row
// per active mode under the headline counters; renders nothing when
// `modes` is undefined / empty so single-process miners keep the same
// UI. Source: /api/v1/status.modes via the indexer's observability
// pass-through (no DB persistence — pure pass-through on each poll).
function ModesBreakdownRow({ modes }: { modes: Record<string, ModeBreakdown> | undefined }) {
  const entries = modes ? Object.entries(modes) : [];
  if (entries.length === 0) return null;
  // Stable display order: cpu, gpu, qpu, then anything else
  // alphabetically (matches the canonical MODE_NAMES tuple on the
  // miner side — operators reading two containers' dashboards see
  // the same order).
  const order = ["cpu", "gpu", "qpu"];
  entries.sort(([a], [b]) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });
  return (
    <div className="mt-4 border-t border-brand-gray-2 pt-4">
      <div className="mb-2 font-accent text-xs text-brand-gray-3">
        Backends — per-mode contribution (multi-process container)
      </div>
      <table className="w-full font-accent text-xs tabular-nums">
        <thead>
          <tr className="border-b border-brand-gray-2 text-left text-brand-gray-3">
            <th className="py-1 pr-4">Mode</th>
            <th className="py-1 pr-4">Workers</th>
            <th className="py-1 pr-4">Heads Observed</th>
            <th className="py-1 pr-4">Contexts</th>
            <th className="py-1 pr-4">Submitted</th>
            <th className="py-1 pr-4">Stale</th>
            <th className="py-1">Errors</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([mode, m]) => (
            <tr key={mode} className="border-b border-brand-gray-2/40 last:border-0">
              <td className="py-1 pr-4 text-brand-gray-6 uppercase">{mode}</td>
              <td className="py-1 pr-4 text-brand-gray-5">{m.miners.length}</td>
              <td className="py-1 pr-4 text-brand-gray-5">{formatNumber(m.headsObserved)}</td>
              <td className="py-1 pr-4 text-brand-gray-5">{formatNumber(m.contextsDispatched)}</td>
              <td className="py-1 pr-4 text-brand-gray-5">{formatNumber(m.proofsSubmitted)}</td>
              <td className="py-1 pr-4 text-brand-gray-5">{formatNumber(m.staleDrops)}</td>
              <td
                className={
                  m.submissionErrors > 0 ? "py-1 text-brand-red-0" : "py-1 text-brand-gray-5"
                }
              >
                {formatNumber(m.submissionErrors)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
