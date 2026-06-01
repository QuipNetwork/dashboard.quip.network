// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, type KeyboardEvent, type ReactNode } from "react";

import { formatDuration, formatNumber } from "../../../lib/format";
import { ChartCard } from "../../layout/ChartCard";
import type { MiningSubmissionRecord } from "../../../types/telemetry";
import { MiningAttemptsModal } from "./MiningAttemptsModal";
import { tsNsToMs } from "./mining-shared";

const RECENT_SUBMISSIONS_VISIBLE = 20;

// Row-per-submission view of the operator's recent mining activity.
// Two row sources merged upstream in `use-my-node`:
//   - Local: `mining_submissions` rows (fetched via
//     `/api/v1/mining/attempts?solution_number=N`). Full fidelity —
//     solutionNumber, attemptCount, outcome.
//   - Chain-only: synthetic rows for self-won blocks the local table
//     doesn't cover (older wins outside the indexer's recent window).
//     Identified by `s.chainOnly === true`; the panel renders an
//     em-dash for attemptCount and suppresses the modal click on those
//     rows (no local attempts log to fetch). Their "Sol #" shows the
//     win's solution_number ordinal (derived from its rank among all
//     winning blocks in use-my-node), and "Block" shows the block height.
//
// Hidden when no submissions of either kind have been observed yet: a
// fresh miner that hasn't won AND hasn't logged a local row.
export function RecentMiningPanel({
  submissions,
  nowMs,
}: {
  submissions: MiningSubmissionRecord[];
  // Wall-clock used for "Age" — prop-injected to match the rest of MyNode
  // and stay swap-friendly for `selectServerNowMs`.
  nowMs: number;
}) {
  const [openSolutionNumber, setOpenSolutionNumber] = useState<number | null>(null);
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
                <th
                  className="py-2 pr-4"
                  title="Global chain solution_number (quip-protocol MR !105) — the winning-solution ordinal the miner works, durable across restarts. Distinct from the substrate block height where a win landed (the 'Block' column)."
                >
                  Sol&nbsp;#
                </th>
                <th
                  className="py-2 pr-4"
                  title="Backend that produced this submission (CPU / CUDA / METAL / MODAL / QPU). Multi-backend rigs run one quip-miner process per active config group; this column shows which one won."
                >
                  Backend
                </th>
                <th className="py-2 pr-4">Best Energy</th>
                <th className="py-2 pr-4">Diversity</th>
                <th
                  className="py-2 pr-4"
                  title="Submission-level num_valid (quip-protocol MR !105) — count of unique samples meeting the energy threshold at submit time, i.e. the count the chain accepts (≥ min_solutions below max_energy). Falls back to the submitted iteration's solution_meta.n_unique_total (sampler productivity) for pre-!105 miners; 0 when the miner publishes no count anywhere."
                >
                  Solutions
                </th>
                <th className="py-2 pr-4">Attempts</th>
                <th className="py-2 pr-4">Outcome</th>
                <th className="py-2 pr-4">Block</th>
                <th className="py-2">Age</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s, idx) => {
                const ageMs = ageFromTsNs(s.tsNs, nowMs);
                const isChainOnly = s.chainOnly === true;
                // Chain-only rows have no real solutionNumber (sentinel 0)
                // and no local attempts log, so don't open the modal.
                // Key falls back to chain block + index because synthetic
                // rows share solutionNumber=0.
                const rowKey = isChainOnly
                  ? `chain-${s.chainBlockNumber ?? idx}`
                  : `${s.minerId}-${s.solutionNumber}`;
                const handleOpen = () => {
                  if (!isChainOnly) setOpenSolutionNumber(s.solutionNumber);
                };
                return (
                  <tr
                    key={rowKey}
                    {...(isChainOnly
                      ? {}
                      : {
                          onClick: handleOpen,
                          role: "button" as const,
                          tabIndex: 0,
                          onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleOpen();
                            }
                          },
                        })}
                    className={
                      isChainOnly
                        ? "border-b border-brand-gray-2/40 last:border-0"
                        : "cursor-pointer border-b border-brand-gray-2/40 last:border-0 hover:bg-brand-gray-1/40"
                    }
                  >
                    <td className="py-1.5 pr-4 text-brand-gray-5">{solDisplay(s)}</td>
                    <td className="py-1.5 pr-4 text-brand-gray-5">
                      {s.minerType ? s.minerType : <span className="text-brand-gray-3">—</span>}
                    </td>
                    <td className="py-1.5 pr-4 text-brand-gray-6">
                      {milliToFixed(s.bestEnergyMilli, 3)}
                    </td>
                    <td className="py-1.5 pr-4 text-brand-gray-5">
                      {milliToFixed(s.diversityMilli, 3)}
                    </td>
                    <td className="py-1.5 pr-4 text-brand-gray-5">{formatNumber(s.numValid)}</td>
                    <td className="py-1.5 pr-4 text-brand-gray-5">
                      {isChainOnly ? (
                        <span className="text-brand-gray-3">—</span>
                      ) : (
                        formatNumber(s.attemptCount)
                      )}
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

      {openSolutionNumber !== null && (
        <MiningAttemptsModal
          solutionNumber={openSolutionNumber}
          onClose={() => setOpenSolutionNumber(null)}
        />
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
 * "Sol #" = the global chain solution_number (quip-protocol MR !105): the
 * winning-solution ordinal the miner keys its directories on. This is
 * distinct from the substrate block height where a win landed — that's the
 * separate "Block" column. Local rows carry the miner's solution_number
 * directly; chain-only synthetic rows derive it as the block's rank among
 * all wins (see use-my-node). Em-dash only for the sentinel-zero case (a
 * synthetic row whose block fell outside the loaded list).
 */
function solDisplay(s: MiningSubmissionRecord): ReactNode {
  if (s.solutionNumber > 0) return `#${formatNumber(s.solutionNumber)}`;
  return <span className="text-brand-gray-3">—</span>;
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
  const tsMs = tsNsToMs(tsNs);
  return tsMs === null ? null : nowMs - tsMs;
}
