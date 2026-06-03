// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDuration, formatNumber } from "../../../lib/format";
import { ChartCard } from "../../layout/ChartCard";
import type {
  CurrentDispatch,
  MiningAttempt,
  MiningSubmissionRecord,
} from "../../../types/telemetry";
import { meetingTargetCount, numericField, tsNsToMs } from "./mining-shared";

// Iteration trail for the global solution_number the miner is currently
// grinding (MR !105). The server probes `Σ proofsWon + 1` (in-flight) and
// falls back to `Σ proofsWon` (the just-completed problem). The badge in
// the panel header surfaces which case we're in — "In flight" means the
// miner is actively grinding; "Last completed" means the panel is showing
// a finished solution and no iterations for the next have landed yet
// (sometimes a stuck-miner signal); "Stale" means an in-flight trail whose
// newest iteration is older than STALE_ITERATION_MS — the miner stopped
// emitting iterations, or it's serving an un-rotated attempts log. A
// single solution_number directory accumulates iterations from several
// dispatches (re-dispatch on each new head, or a restart mid-solution),
// each of which restarts `iter` at 1 — so iter collides within a solution
// and the trail is ordered by ts_ns, not iter.
//
// When the solution has produced a chain-side submission record, we also
// surface the submission's `outcome` (chain_error / submitted_inblock /
// ...) so the operator can tell a successful submission from a
// chain-rejected one without scrolling to Recent Performance.
export function CurrentAttemptsPanel({
  dispatch,
  recentSubmissions,
  problemNumber,
  nowMs,
}: {
  dispatch: CurrentDispatch | null;
  // For outcome-badge resolution: find the matching submission row by
  // solutionNumber. Empty array is fine — the badge just doesn't render.
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

  // Newest-first by ts_ns, NOT iter — iter collides across the multiple
  // dispatches accumulated under one solution_number (see
  // orderAttemptsByRecency).
  const sorted = orderAttemptsByRecency(dispatch.attempts);
  const matchingSubmission = recentSubmissions.find(
    (s) => s.solutionNumber === dispatch.solutionNumber,
  );
  const stale = isTrailStale(sorted, dispatch.status, nowMs);
  const newestAgeMs = stale ? newestIterationAgeMs(sorted, nowMs) : null;

  return (
    <ChartCard
      title={heading}
      subtitle={`Solution #${formatNumber(dispatch.solutionNumber)} · ${sorted.length} iteration${sorted.length === 1 ? "" : "s"}`}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusBadge status={stale ? "stale" : dispatch.status} />
        {stale && newestAgeMs !== null && (
          <span className="font-accent text-[10px] text-brand-yellow-0">
            newest iteration {formatDuration(newestAgeMs)} old — miner may be stalled or serving an
            un-rotated attempts log
          </span>
        )}
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

function StatusBadge({ status }: { status: CurrentDispatch["status"] | "stale" }) {
  const tone =
    status === "in-flight"
      ? "border-brand-green-0/40 text-brand-green-0"
      : status === "stale"
        ? "border-brand-yellow-0/40 text-brand-yellow-0"
        : "border-brand-gray-2 text-brand-gray-4";
  const label =
    status === "in-flight" ? "In flight" : status === "stale" ? "Stale" : "Last completed";
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

/**
 * Absolute wall-clock of one iteration, in ms, from its `ts_ns` field
 * (u128 nanoseconds, number or string). Returns null when the field is
 * absent or unparseable — callers render an em-dash rather than NaN.
 */
function iterTsMs(extra: Record<string, unknown>): number | null {
  return tsNsToMs(extra["ts_ns"]);
}

function extractAgeMs(extra: Record<string, unknown>, nowMs: number): number | null {
  const tsMs = iterTsMs(extra);
  return tsMs === null ? null : nowMs - tsMs;
}

/**
 * Newest iteration is stale beyond this → demote the "In flight" badge.
 * Headroom over the slowest realistic gap between QPU iterations
 * (D-Wave cloud queue + anneal can run tens of seconds per iter); past
 * this the trail almost certainly reflects a stalled miner or an
 * un-rotated attempts log, not live grinding.
 */
export const STALE_ITERATION_MS = 5 * 60 * 1000;

/**
 * Order the iteration trail newest-first by `ts_ns`.
 *
 * `iter` is NOT a safe recency key. A single global `solution_number`
 * directory accumulates iterations from several dispatches (re-dispatch
 * on each new head, or a restart mid-solution), each of which restarts
 * `iter` at 1 — so iter numbers collide within one solution. Sorting by
 * `iter` then floats a long prior run's high iters (e.g. iter 934 from
 * 24h ago) above the current run's low iters (e.g. iter 66 from minutes
 * ago) — exactly the stale "In flight" trail that motivated this. `ts_ns`
 * never collides.
 *
 * Rows missing `ts_ns` sort last, tie-broken by `iter` descending.
 */
export function orderAttemptsByRecency(attempts: MiningAttempt[]): MiningAttempt[] {
  return [...attempts].sort((a, b) => {
    const ta = iterTsMs(a.extra);
    const tb = iterTsMs(b.extra);
    if (ta !== null && tb !== null && ta !== tb) return tb - ta;
    if (ta !== null && tb === null) return -1;
    if (ta === null && tb !== null) return 1;
    return b.iter - a.iter;
  });
}

/**
 * Age (ms) of the most recent iteration in a recency-ordered trail, or
 * null when no iteration carries a parseable `ts_ns`.
 */
export function newestIterationAgeMs(
  orderedNewestFirst: MiningAttempt[],
  nowMs: number,
): number | null {
  for (const a of orderedNewestFirst) {
    const tsMs = iterTsMs(a.extra);
    if (tsMs !== null) return nowMs - tsMs;
  }
  return null;
}

/**
 * True when an in-flight dispatch's newest iteration is older than
 * `STALE_ITERATION_MS`. Only in-flight dispatches qualify — a
 * "completed" trail showing old rows is expected and not misleading.
 * A stale in-flight trail means the miner stopped emitting iterations
 * (stall) or is serving an un-rotated log whose newest rows predate the
 * current run.
 */
export function isTrailStale(
  orderedNewestFirst: MiningAttempt[],
  status: CurrentDispatch["status"],
  nowMs: number,
): boolean {
  if (status !== "in-flight") return false;
  const ageMs = newestIterationAgeMs(orderedNewestFirst, nowMs);
  return ageMs !== null && ageMs > STALE_ITERATION_MS;
}
