// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDuration, formatNumber } from "../../../lib/format";
import { ChartCard } from "../../layout/ChartCard";
import type { BlockRecord } from "../../../types/telemetry";

const RECENT_WINS_LIMIT = 20;

/**
 * Operator's recent winning solutions — the lowest-energy proof per block
 * the chain canonicalized for this account. Limited to the
 * {@link RECENT_WINS_LIMIT} most-recent. quip-node's REST API only exposes
 * aggregate counters, so this is the dashboard's best view of "recent
 * attempts" — losing ProofAccepted events from the same block are not
 * persisted yet (would need a `proof_attempts` table in the indexer).
 */
export function RecentPerformancePanel({
  selfAddress,
  blocks,
  nowMs,
  chainProofsWon,
}: {
  selfAddress: string;
  blocks: BlockRecord[];
  // Wall-clock used for the "Time ago" column. Passed in so the parent
  // can swap in `selectServerNowMs` later without touching this component.
  nowMs: number;
  // Chain-authoritative `proofs_won` count. Used to label each row with
  // its solution number; the newest row is solution #chainProofsWon and
  // we count down by index. Rows whose computed number drops to ≤0 are
  // tagged stale — that means the local DB has more rows than the chain
  // currently knows about, typically because a prior chain run left
  // entries behind across a `make localdev` rebuild.
  chainProofsWon: number;
}) {
  const selfBlocks = blocks.filter((b) => b.minerId === selfAddress).slice(0, RECENT_WINS_LIMIT);

  if (selfBlocks.length === 0) return null;

  return (
    <ChartCard
      title="Recent Performance Details"
      subtitle={`Your last ${selfBlocks.length} winning solutions. Lower energy = better submission; quip-protocol-rs canonicalizes the lowest-energy proof per block as the winner.`}
    >
      <div className="overflow-x-auto">
        <table className="w-full font-accent text-xs tabular-nums">
          <thead>
            <tr className="border-b border-brand-gray-2 text-left text-brand-gray-3">
              <th className="py-2 pr-4">Solution</th>
              <th className="py-2 pr-4">Block</th>
              <th className="py-2 pr-4">Energy</th>
              <th className="py-2 pr-4">Diversity</th>
              <th className="py-2 pr-4">Solutions</th>
              <th className="py-2 pr-4">Mining Time</th>
              <th className="py-2">Time Ago</th>
            </tr>
          </thead>
          <tbody>
            {selfBlocks.map((b, i) => {
              const ageMs = nowMs - b.timestamp * 1000;
              const solutionNumber = chainProofsWon - i;
              const isStale = solutionNumber <= 0;
              return (
                <tr
                  key={b.substrateBlockNumber}
                  className="border-b border-brand-gray-2/40 last:border-0"
                >
                  <td className="py-1.5 pr-4 text-brand-gray-5">
                    {isStale ? (
                      <span
                        className="text-brand-gray-3 italic"
                        title="Local DB row from a prior chain run; not reflected in current chain's proofs_won"
                      >
                        stale
                      </span>
                    ) : (
                      `#${formatNumber(solutionNumber)}`
                    )}
                  </td>
                  <td className="py-1.5 pr-4 text-brand-gray-5">#{b.substrateBlockNumber}</td>
                  <td className="py-1.5 pr-4 text-brand-gray-6">{b.energy.toFixed(2)}</td>
                  <td className="py-1.5 pr-4 text-brand-gray-5">{b.diversity.toFixed(3)}</td>
                  <td className="py-1.5 pr-4 text-brand-gray-5">
                    {formatNumber(b.numValidSolutions)}
                  </td>
                  <td className="py-1.5 pr-4 text-brand-gray-5">
                    {b.miningTime > 0 ? formatDuration(b.miningTime * 1000) : "—"}
                  </td>
                  <td className="py-1.5 text-brand-gray-4">
                    {ageMs > 0 ? `${formatDuration(ageMs)} ago` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}
