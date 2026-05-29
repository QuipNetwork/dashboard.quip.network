// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDuration, formatNumber } from "../../../lib/format";
import { ChartCard } from "../../layout/ChartCard";
import type { CurrentDispatch, MiningSubmissionRecord } from "../../../types/telemetry";

// Iteration trail for the miner's most recent dispatch. The server
// probes `contextsDispatched + 1` (in-flight if the miner has started
// the next problem) and falls back to `contextsDispatched` (the just-
// completed dispatch). The badge in the panel header surfaces which
// case we're in — "In flight" means the miner is actively grinding;
// "Last completed" means the panel is showing a finished dispatch and
// no new one has started yet (sometimes a stuck-miner signal).
//
// When the dispatch has produced a chain-side submission record, we
// also surface the submission's `outcome` (chain_error / submitted_inblock
// / ...) so the operator can tell a successful submission from a
// chain-rejected one without scrolling to Recent Performance.
export function CurrentAttemptsPanel({
  dispatch,
  recentSubmissions,
  problemNumber,
  nowMs,
}: {
  dispatch: CurrentDispatch | null;
  // For outcome-badge resolution: find the matching submission row by
  // dispatchId. Empty array is fine — the badge just doesn't render.
  recentSubmissions: MiningSubmissionRecord[];
  // Display label for the current target problem — chain proofs_won + 1.
  // Matches the header indicator. Null when proofs_won isn't known.
  problemNumber: number | null;
  // Wall-clock for "age" calculations against iteration ts_ns.
  nowMs: number;
}) {
  const heading =
    problemNumber != null && problemNumber > 0
      ? `Current Attempts · problem #${formatNumber(problemNumber)}`
      : "Current Attempts";

  if (dispatch === null || dispatch.attempts.length === 0) {
    return (
      <ChartCard
        title={heading}
        subtitle="Live iteration trail. Empty between dispatches or while the miner is dialing in on the next problem."
      >
        <p className="font-accent text-xs text-brand-gray-3">No attempts yet.</p>
      </ChartCard>
    );
  }

  const sorted = [...dispatch.attempts].sort((a, b) => b.iter - a.iter);
  const matchingSubmission = recentSubmissions.find((s) => s.dispatchId === dispatch.dispatchId);

  return (
    <ChartCard
      title={heading}
      subtitle={`Dispatch #${formatNumber(dispatch.dispatchId)} · ${sorted.length} iteration${sorted.length === 1 ? "" : "s"}`}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusBadge status={dispatch.status} />
        {matchingSubmission && <OutcomeBadge outcome={matchingSubmission.outcome} />}
        {matchingSubmission?.chainBlockNumber && (
          <span className="font-accent text-[10px] text-brand-gray-4">
            chain block #{matchingSubmission.chainBlockNumber}
          </span>
        )}
      </div>

      <div className="max-h-[60vh] overflow-auto">
        <table className="w-full font-accent text-xs tabular-nums">
          <thead className="sticky top-0 bg-brand-bg">
            <tr className="border-b border-brand-gray-2 text-left text-brand-gray-3">
              <th className="py-2 pr-4">Iter</th>
              <th className="py-2 pr-4">Best Energy</th>
              <th
                className="py-2 pr-4"
                title="Reported only on submitted iterations — the miner API returns null here for rejected/stored rows even when post-processing ran."
              >
                Diversity
              </th>
              <th
                className="py-2 pr-4"
                title="solution_meta.n_unique_below_threshold — count of unique samples with energy strictly below the live chain threshold at iteration time. Em-dash on mempool-path iterations where the miner can't recompute energies against a live threshold."
              >
                Solutions
              </th>
              <th className="py-2 pr-4">Result</th>
              <th className="py-2 pr-4">Mining Time</th>
              <th className="py-2">Age</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => {
              const diversityMilli = numericField(a.extra["diversity_milli"]);
              const numMeetingTarget = meetingTargetCount(a.extra);
              const miningTimeUs = extractMiningTimeUs(a.extra);
              const ageMs = extractAgeMs(a.extra, nowMs);
              return (
                <tr key={a.iter} className="border-b border-brand-gray-2/40 last:border-0">
                  <td className="py-1.5 pr-4 text-brand-gray-5">{a.iter}</td>
                  <td className="py-1.5 pr-4 text-brand-gray-6">
                    {(a.bestEnergyMilli / 1000).toFixed(3)}
                  </td>
                  <td className="py-1.5 pr-4 text-brand-gray-5">
                    {diversityMilli !== null ? (diversityMilli / 1000).toFixed(3) : "—"}
                  </td>
                  <td className="py-1.5 pr-4 text-brand-gray-5">
                    {numMeetingTarget !== null ? formatNumber(numMeetingTarget) : "—"}
                  </td>
                  <td className="py-1.5 pr-4">
                    <ResultBadge kind={a.resultKind} />
                  </td>
                  <td className="py-1.5 pr-4 text-brand-gray-4">
                    {miningTimeUs !== null ? `${(miningTimeUs / 1_000_000).toFixed(1)}s` : "—"}
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
  );
}

function StatusBadge({ status }: { status: CurrentDispatch["status"] }) {
  const tone =
    status === "in-flight"
      ? "border-brand-green-0/40 text-brand-green-0"
      : "border-brand-gray-2 text-brand-gray-4";
  const label = status === "in-flight" ? "In flight" : "Last completed";
  return (
    <span
      className={`inline-block rounded-md border px-1.5 py-0.5 font-accent text-[10px] ${tone}`}
    >
      {label}
    </span>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const lower = outcome.toLowerCase();
  // Match chain_error (and friends like submission_error) explicitly —
  // the operator's diagnostic flag for "miner submitted but chain
  // rejected", which is otherwise invisible in the iteration trail.
  const tone: string = lower.includes("error")
    ? "border-brand-red-0/40 text-brand-red-0"
    : lower.includes("inblock") || lower.includes("submitted")
      ? "border-brand-green-0/40 text-brand-green-0"
      : "border-brand-gray-2 text-brand-gray-4";
  return (
    <span
      className={`inline-block rounded-md border px-1.5 py-0.5 font-accent text-[10px] ${tone}`}
    >
      outcome: {outcome}
    </span>
  );
}

function ResultBadge({ kind }: { kind: string }) {
  const lower = kind.toLowerCase();
  const tone: string = lower.includes("submitted")
    ? "border-brand-green-0/40 text-brand-green-0"
    : lower.includes("reject")
      ? "border-brand-red-0/40 text-brand-red-0"
      : lower.includes("stored")
        ? "border-brand-yellow-0/40 text-brand-yellow-0"
        : "border-brand-gray-2 text-brand-gray-4";
  return (
    <span
      className={`inline-block rounded-md border px-1.5 py-0.5 font-accent text-[10px] ${tone}`}
    >
      {kind || "—"}
    </span>
  );
}

function extractMiningTimeUs(extra: Record<string, unknown>): number | null {
  return numericField(extra["mining_time_us"]);
}

function extractAgeMs(extra: Record<string, unknown>, nowMs: number): number | null {
  const tsNs = extra["ts_ns"];
  try {
    if (typeof tsNs === "number" && Number.isFinite(tsNs)) {
      return nowMs - Math.floor(tsNs / 1_000_000);
    }
    if (typeof tsNs === "string") {
      return nowMs - Number(BigInt(tsNs) / 1_000_000n);
    }
  } catch {
    return null;
  }
  return null;
}

function numericField(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Count of unique below-threshold samples for one iteration. Post
 * quip-protocol MR !103 this lives in `solution_meta.n_unique_below_threshold`;
 * older miner images published it as the now-removed top-level
 * `num_solutions_meeting_target`. Returns null (rendered as an em-dash)
 * when neither is present.
 */
function meetingTargetCount(extra: Record<string, unknown>): number | null {
  const meta = extra["solution_meta"];
  if (meta && typeof meta === "object") {
    const n = numericField((meta as Record<string, unknown>)["n_unique_below_threshold"]);
    if (n !== null) return n;
  }
  return numericField(extra["num_solutions_meeting_target"]);
}
