// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDuration, formatNumber } from "../../../lib/format";
import { ChartCard } from "../../layout/ChartCard";
import type { MiningAttempt } from "../../../types/telemetry";

// Iteration trail for the in-flight dispatch — what the miner is doing
// RIGHT NOW against the current outstanding problem. Server fetches the
// dispatch_id form of `/api/v1/mining/attempts` and ships the array on
// every /api/telemetry poll, so this advances live as the miner grinds.
//
// Empty state covers two cases:
//   - Miner is between dispatches (just won, or hasn't started yet)
//   - Upstream fetch failed (miner unreachable, controller error)
// Surfaced explicitly so the operator can tell "nothing happening" from
// "this miner is wedged".
export function CurrentAttemptsPanel({
  attempts,
  problemNumber,
}: {
  attempts: MiningAttempt[];
  // Display label for the current target problem — chain proofs_won + 1.
  // Matches the header indicator. Null when proofs_won isn't known.
  problemNumber: number | null;
}) {
  // Reverse-sort so the newest iteration is on top — same convention as
  // RecentMiningPanel and RecentPerformancePanel.
  const sorted = [...attempts].sort((a, b) => b.iter - a.iter);
  const heading =
    problemNumber != null && problemNumber > 0
      ? `Current Attempts · problem #${formatNumber(problemNumber)}`
      : "Current Attempts";

  if (sorted.length === 0) {
    return (
      <ChartCard
        title={heading}
        subtitle="Live iteration trail. Empty between dispatches or while the miner is dialing in on the next problem."
      >
        <p className="font-accent text-xs text-brand-gray-3">No attempts yet.</p>
      </ChartCard>
    );
  }

  return (
    <ChartCard
      title={heading}
      subtitle={`In-flight iterations for the current dispatch (${sorted.length} so far).`}
    >
      <div className="overflow-x-auto">
        <table className="w-full font-accent text-xs tabular-nums">
          <thead>
            <tr className="border-b border-brand-gray-2 text-left text-brand-gray-3">
              <th className="py-2 pr-4">Iter</th>
              <th className="py-2 pr-4">Best Energy</th>
              <th className="py-2 pr-4">Threshold</th>
              <th className="py-2 pr-4">Result</th>
              <th className="py-2 pr-4">Mining Time</th>
              <th className="py-2">Age</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => {
              const threshold = extractThresholdMilli(a.extra);
              const miningTimeUs = extractMiningTimeUs(a.extra);
              const ageMs = extractAgeMs(a.extra);
              return (
                <tr
                  key={a.iter}
                  className="border-b border-brand-gray-2/40 last:border-0"
                >
                  <td className="py-1.5 pr-4 text-brand-gray-5">{a.iter}</td>
                  <td className="py-1.5 pr-4 text-brand-gray-6">
                    {(a.bestEnergyMilli / 1000).toFixed(3)}
                  </td>
                  <td className="py-1.5 pr-4 text-brand-gray-5">
                    {threshold !== null ? `≤ ${(threshold / 1000).toFixed(3)}` : "—"}
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
    <span className={`inline-block rounded-md border px-1.5 py-0.5 font-accent text-[10px] ${tone}`}>
      {kind || "—"}
    </span>
  );
}

/**
 * Pull `threshold_milli` out of the miner's extra fields. Returns null
 * when it's missing or non-numeric — `ratchet_threshold_milli` is a
 * deliberate fallback for miners that surface the dynamic threshold
 * instead of the static one.
 */
function extractThresholdMilli(extra: Record<string, unknown>): number | null {
  const a = numericField(extra["threshold_milli"]);
  if (a !== null) return a;
  return numericField(extra["ratchet_threshold_milli"]);
}

function extractMiningTimeUs(extra: Record<string, unknown>): number | null {
  return numericField(extra["mining_time_us"]);
}

function extractAgeMs(extra: Record<string, unknown>): number | null {
  const tsNs = extra["ts_ns"];
  // The miner sends `ts_ns` as a number in JSON (it fits in IEEE-754 for
  // any reasonable wall-clock past 2024, but we still divide carefully).
  // Falls back to BigInt parse for safety; if neither path works, no age.
  try {
    if (typeof tsNs === "number" && Number.isFinite(tsNs)) {
      return Date.now() - Math.floor(tsNs / 1_000_000);
    }
    if (typeof tsNs === "string") {
      return Date.now() - Number(BigInt(tsNs) / 1_000_000n);
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
