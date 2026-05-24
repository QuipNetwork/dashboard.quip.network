// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";

import { formatDuration, formatNumber } from "../../../lib/format";
import { ChartCard } from "../../layout/ChartCard";
import type { MiningSubmissionRecord } from "../../../types/telemetry";
import { MiningAttemptsModal } from "./MiningAttemptsModal";

const RECENT_SUBMISSIONS_VISIBLE = 20;

// Row-per-submission view of the locally-polled miner's most recent
// submissions, sourced from `/api/v1/mining/attempts?solution_id=N`
// (one fetch per new solution_id by the indexer's tip-worker). Each row
// is clickable — opens a modal that proxies fresh through the server
// for the iteration trail (not stored on the indexer to keep row count
// bounded).
//
// Hidden when no submissions have been observed yet: a fresh miner, or
// — surfaced as a diagnostic during the v0.3 deploy — a miner that's
// targeting the un-decayed base difficulty and self-rejecting every
// candidate. Once the miner-side decay fix lands, this populates in
// real time.
export function RecentMiningPanel({
  submissions,
  nowMs,
}: {
  submissions: MiningSubmissionRecord[];
  // Wall-clock used for "Age" — prop-injected to match the rest of MyNode
  // and stay swap-friendly for `selectServerNowMs`.
  nowMs: number;
}) {
  const [openSolutionId, setOpenSolutionId] = useState<number | null>(null);
  const shown = submissions.slice(0, RECENT_SUBMISSIONS_VISIBLE);
  if (shown.length === 0) return null;

  return (
    <>
      <ChartCard
        title="Recent Performance"
        subtitle={`Last ${shown.length} submissions by this miner. Click a row to see the per-iteration trajectory.`}
      >
        <div className="overflow-x-auto">
          <table className="w-full font-accent text-xs tabular-nums">
            <thead>
              <tr className="border-b border-brand-gray-2 text-left text-brand-gray-3">
                <th className="py-2 pr-4">Sol&nbsp;#</th>
                <th className="py-2 pr-4">Best Energy</th>
                <th className="py-2 pr-4">Diversity</th>
                <th className="py-2 pr-4">Solutions</th>
                <th className="py-2 pr-4">Attempts</th>
                <th className="py-2 pr-4">Outcome</th>
                <th className="py-2 pr-4">Block</th>
                <th className="py-2">Age</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => {
                const ageMs = ageFromTsNs(s.tsNs, nowMs);
                return (
                  <tr
                    key={`${s.minerId}-${s.solutionId}`}
                    onClick={() => setOpenSolutionId(s.solutionId)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenSolutionId(s.solutionId);
                      }
                    }}
                    className="cursor-pointer border-b border-brand-gray-2/40 last:border-0 hover:bg-brand-gray-1/40"
                  >
                    <td className="py-1.5 pr-4 text-brand-gray-5">#{formatNumber(s.solutionId)}</td>
                    <td className="py-1.5 pr-4 text-brand-gray-6">
                      {milliToFixed(s.bestEnergyMilli, 3)}
                    </td>
                    <td className="py-1.5 pr-4 text-brand-gray-5">
                      {milliToFixed(s.diversityMilli, 3)}
                    </td>
                    <td className="py-1.5 pr-4 text-brand-gray-5">
                      {formatNumber(s.numValidSolutions)}
                    </td>
                    <td className="py-1.5 pr-4 text-brand-gray-5">
                      {formatNumber(s.attemptCount)}
                    </td>
                    <td className="py-1.5 pr-4">
                      <OutcomeBadge outcome={s.outcome} />
                    </td>
                    <td className="py-1.5 pr-4 text-brand-gray-4">
                      {s.chainBlockNumber ? `#${s.chainBlockNumber}` : "—"}
                    </td>
                    <td className="py-1.5 text-brand-gray-4">
                      {ageMs !== null && ageMs > 0 ? `${formatDuration(ageMs)} ago` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ChartCard>

      {openSolutionId !== null && (
        <MiningAttemptsModal solutionId={openSolutionId} onClose={() => setOpenSolutionId(null)} />
      )}
    </>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  // The miner's outcome string is an open enum — match a few known values
  // and fall back to a neutral style for anything else. Keep the labels
  // verbatim so the operator sees exactly what the miner reported.
  const lower = outcome.toLowerCase();
  const tone: string = lower.includes("submitted")
    ? "border-brand-green-0/40 text-brand-green-0"
    : lower.includes("reject")
      ? "border-brand-red-0/40 text-brand-red-0"
      : "border-brand-gray-2 text-brand-gray-4";
  return (
    <span
      className={`inline-block rounded-md border px-1.5 py-0.5 font-accent text-[10px] ${tone}`}
    >
      {outcome}
    </span>
  );
}

/**
 * Convert milli-units to a fixed-decimal string. Handles negative
 * values (energy is typically negative in this codebase) and returns
 * an em-dash sentinel for non-finite numbers.
 */
function milliToFixed(milli: number, digits: number): string {
  if (!Number.isFinite(milli)) return "—";
  return (milli / 1000).toFixed(digits);
}

/**
 * Age in milliseconds from a u128 nanosecond timestamp string. Returns
 * null if the input doesn't parse — better to render an em-dash than to
 * surface NaN durations.
 */
function ageFromTsNs(tsNs: string, nowMs: number): number | null {
  try {
    const tsMs = Number(BigInt(tsNs) / 1_000_000n);
    if (!Number.isFinite(tsMs)) return null;
    return nowMs - tsMs;
  } catch {
    return null;
  }
}
