// SPDX-License-Identifier: AGPL-3.0-or-later

import clsx from "clsx";

import { formatNumber } from "@/lib/format";
import { shortAddress } from "@/lib/format-chain";
import type { MiningAttempt, MiningAttemptsResponse } from "@/types/telemetry";
import { ResultBadge } from "./mining-badges";
import { meetingTargetCount } from "./mining-shared";

export function SubmissionDetails({ envelope }: { envelope: MiningAttemptsResponse }) {
  const { submission, attempts } = envelope;
  return (
    <>
      <dl className="mb-5 grid grid-cols-2 gap-x-4 gap-y-2 font-accent text-sm">
        <Row
          label="Miner"
          value={shortAddress(submission.minerId, 8, 6)}
          mono
          title={submission.minerId}
        />
        <Row label="Solution #" value={formatNumber(submission.solutionNumber)} />
        {submission.powSequence !== null && (
          <Row label="PoW Seq" value={formatNumber(submission.powSequence)} />
        )}
        <Row label="Energy" value={(submission.energyMilli / 1000).toFixed(3)} />
        <Row label="Threshold" value={`≤ ${(submission.thresholdMilli / 1000).toFixed(3)}`} />
        <Row label="Diversity" value={(submission.diversityMilli / 1000).toFixed(3)} />
        <Row label="Attempts" value={formatNumber(submission.attemptCount)} />
        <Row
          label="Last Proof Block"
          value={shortAddress(submission.lastProofBlockHash, 10, 8)}
          mono
          title={submission.lastProofBlockHash}
          span={2}
        />
        {submission.extrinsicHash && (
          <Row
            label="Extrinsic"
            value={shortAddress(submission.extrinsicHash, 10, 8)}
            mono
            title={submission.extrinsicHash}
            span={2}
          />
        )}
        {submission.chainBlockHash && (
          <Row
            label="Chain Block"
            value={shortAddress(submission.chainBlockHash, 10, 8)}
            mono
            title={submission.chainBlockHash}
            span={2}
          />
        )}
      </dl>

      {attempts.length === 0 ? (
        <p className="font-accent text-sm text-ink-subtle">
          No iteration trail returned. Either the miner didn't record per-iteration data for this
          submission or the controller batched it into a single attempt.
        </p>
      ) : (
        <AttemptsTable attempts={attempts} />
      )}
    </>
  );
}

function AttemptsTable({ attempts }: { attempts: MiningAttempt[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-accent text-xs tabular-nums">
        <thead>
          <tr className="border-b border-border text-left text-ink-subtle">
            <th className="py-2 pr-4">Iter</th>
            <th className="py-2 pr-4">Best Energy</th>
            <th
              className="py-2 pr-4"
              title="solution_meta.n_unique_below_threshold — count of unique samples with energy strictly below the live chain threshold at iteration time. Em-dash on mempool-path iterations where the miner can't recompute energies against a live threshold."
            >
              Solutions
            </th>
            <th className="py-2 pr-4">Result</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((a) => {
            const numMeetingTarget = meetingTargetCount(a.extra);
            return (
              <tr key={a.iter} className="border-b border-border last:border-0">
                <td className="py-1.5 pr-4 text-ink-strong">{a.iter}</td>
                <td className="py-1.5 pr-4 text-ink-strong">
                  {(a.bestEnergyMilli / 1000).toFixed(3)}
                </td>
                <td className="py-1.5 pr-4 text-ink-strong">
                  {numMeetingTarget !== null ? formatNumber(numMeetingTarget) : "—"}
                </td>
                <td className="py-1.5 pr-4">
                  <ResultBadge kind={a.resultKind} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  title,
  span,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
  span?: number;
}) {
  return (
    <div className={span === 2 ? "col-span-2" : undefined}>
      <dt className="font-accent text-[10px] uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd
        className={clsx("font-accent text-sm text-ink-strong", mono && "font-mono")}
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}
