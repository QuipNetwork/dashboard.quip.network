// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDuration, formatNumber } from "../../../lib/format";
import { shortAddress } from "../../../lib/format-chain";
import { ChartCard } from "../../layout/ChartCard";
import type { ProofAttemptRecord } from "../../../types/telemetry";

const RECENT_ATTEMPTS_LIMIT = 20;

/**
 * Every chain-accepted proof at the currently-mined problem. Sourced from
 * `quantum_pow::Event::ProofAccepted` (winners AND non-winning proofs that
 * met difficulty). The server filters by `block_number > LastProofBlock`
 * so this only shows attempts vs the current target — past problems'
 * winning proofs live in the "Recent Performance Details" panel.
 *
 * Hidden when no attempts have been observed yet (fresh chain, or every
 * miner is grinding without submitting because they're targeting the
 * un-decayed base difficulty — a known miner-side bug at v0.2 deploy).
 */
export function RecentAttemptsPanel({
  attempts,
  problemNumber,
  selfAddress,
  nowMs,
}: {
  attempts: ProofAttemptRecord[];
  // Display label for the current target problem (chain proofs_won + 1).
  // Falls back to "current problem" when proofs_won isn't known yet.
  problemNumber: number | null;
  // SS58 of the locally polled miner. Used to highlight self's rows in the
  // table so the operator can find their own attempts in a multi-miner mix.
  selfAddress: string;
  // Wall-clock used for the "Time ago" column. Prop-injected to match
  // RecentPerformancePanel and stay swap-friendly for `selectServerNowMs`.
  nowMs: number;
}) {
  const shown = attempts.slice(0, RECENT_ATTEMPTS_LIMIT);
  if (shown.length === 0) return null;

  const heading =
    problemNumber != null && problemNumber > 0
      ? `Recent Performance vs problem #${formatNumber(problemNumber)}`
      : "Recent Performance vs current problem";

  return (
    <ChartCard
      title={heading}
      subtitle={`Last ${shown.length} chain-accepted proofs since the previous winning block. Includes winners and non-winning proofs that met difficulty.`}
    >
      <div className="overflow-x-auto">
        <table className="w-full font-accent text-xs tabular-nums">
          <thead>
            <tr className="border-b border-brand-gray-2 text-left text-brand-gray-3">
              <th className="py-2 pr-4">Block</th>
              <th className="py-2 pr-4">Miner</th>
              <th className="py-2 pr-4">Energy</th>
              <th className="py-2 pr-4">Diversity</th>
              <th className="py-2 pr-4">Solutions</th>
              <th className="py-2">Time Ago</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => {
              const ageMs = nowMs - a.timestamp * 1000;
              const isSelf = a.minerId === selfAddress;
              return (
                <tr
                  key={`${a.blockNumber}-${a.minerId}-${a.energy}-${a.diversity}-${a.numValidSolutions}`}
                  className="border-b border-brand-gray-2/40 last:border-0"
                >
                  <td className="py-1.5 pr-4 text-brand-gray-5">#{a.blockNumber}</td>
                  <td
                    className={`py-1.5 pr-4 font-mono ${isSelf ? "text-brand-green-0" : "text-brand-gray-5"}`}
                    title={isSelf ? `${a.minerId} (you)` : a.minerId}
                  >
                    {shortAddress(a.minerId)}
                    {isSelf && " · you"}
                  </td>
                  <td className="py-1.5 pr-4 text-brand-gray-6">{a.energy.toFixed(2)}</td>
                  <td className="py-1.5 pr-4 text-brand-gray-5">{a.diversity.toFixed(3)}</td>
                  <td className="py-1.5 pr-4 text-brand-gray-5">
                    {formatNumber(a.numValidSolutions)}
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
