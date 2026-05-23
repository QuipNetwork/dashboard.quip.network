// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";

import { formatNumber } from "../../../lib/format";
import { shortAddress } from "../../../lib/format-chain";
import type { MiningAttempt, MiningAttemptsResponse } from "../../../types/telemetry";

// Modal for a single mining submission: shows the submission summary in
// a dt/dl grid and the per-iteration trail in a table below. Data is
// fetched on demand from the server's proxy (`/api/mining/attempts/:id`)
// because the indexer doesn't persist the iteration array — it can grow
// to thousands of rows per submission and is only relevant when a user
// clicks in for detail. The trade-off: a stopped miner means a stale
// modal; the empty state below makes that explicit.
export function MiningAttemptsModal({
  solutionId,
  onClose,
}: {
  solutionId: number;
  onClose: () => void;
}) {
  const [data, setData] = useState<MiningAttemptsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    fetch(`/api/mining/attempts/${solutionId}`, { signal: ac.signal })
      .then(async (res) => {
        if (res.status === 404) throw new Error(`solution #${solutionId} not found on miner`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<MiningAttemptsResponse>;
      })
      .then((env) => setData(env))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [solutionId]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Mining submission ${solutionId} details`}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-8"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-lg border border-brand-gray-2 bg-brand-bg p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-accent text-lg text-brand-gray-5">
              Submission #{formatNumber(solutionId)}
            </h2>
            {data && (
              <p className="font-accent text-xs text-brand-gray-3">
                {data.submission.outcome}
                {data.submission.chainBlockNumber
                  ? ` · landed at block #${data.submission.chainBlockNumber}`
                  : ""}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer rounded border border-brand-gray-2 px-2 py-0.5 font-accent text-xs text-brand-gray-3 hover:border-brand-gray-3 hover:text-brand-gray-5"
          >
            ×
          </button>
        </div>

        {loading && (
          <p className="font-accent text-sm text-brand-gray-3">Fetching from miner…</p>
        )}
        {error && (
          <div className="rounded border border-brand-red-0/40 bg-brand-red-2/20 p-3">
            <p className="font-accent text-sm text-brand-red-0">{error}</p>
            <p className="mt-1 font-accent text-xs text-brand-gray-4">
              The dashboard proxies this through the indexer; if the miner is offline or
              QUIP_NODE_URL is unreachable, the modal can't populate.
            </p>
          </div>
        )}
        {data && <SubmissionDetails envelope={data} />}
      </div>
    </div>
  );
}

function SubmissionDetails({ envelope }: { envelope: MiningAttemptsResponse }) {
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
        <Row label="Dispatch" value={String(submission.dispatchId)} />
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
        <p className="font-accent text-sm text-brand-gray-3">
          No iteration trail returned. Either the miner didn't record per-iteration data for
          this submission or the controller batched it into a single attempt.
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
          <tr className="border-b border-brand-gray-2 text-left text-brand-gray-3">
            <th className="py-2 pr-4">Iter</th>
            <th className="py-2 pr-4">Best Energy</th>
            <th className="py-2 pr-4">Result</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((a) => (
            <tr key={a.iter} className="border-b border-brand-gray-2/40 last:border-0">
              <td className="py-1.5 pr-4 text-brand-gray-5">{a.iter}</td>
              <td className="py-1.5 pr-4 text-brand-gray-6">
                {(a.bestEnergyMilli / 1000).toFixed(3)}
              </td>
              <td className="py-1.5 pr-4">
                <ResultBadge kind={a.resultKind} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultBadge({ kind }: { kind: string }) {
  const lower = kind.toLowerCase();
  const tone: string = lower.includes("submitted")
    ? "border-brand-green-0/40 text-brand-green-0"
    : lower.includes("reject")
      ? "border-brand-red-0/40 text-brand-red-0"
      : "border-brand-gray-2 text-brand-gray-4";
  return (
    <span className={`inline-block rounded-md border px-1.5 py-0.5 font-accent text-[10px] ${tone}`}>
      {kind || "—"}
    </span>
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
      <dt className="font-accent text-[10px] uppercase tracking-wider text-brand-gray-3">
        {label}
      </dt>
      <dd
        className={`font-accent text-sm text-brand-gray-5 ${mono ? "font-mono" : ""}`}
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}
