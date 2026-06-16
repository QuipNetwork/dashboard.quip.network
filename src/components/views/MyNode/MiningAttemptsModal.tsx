// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";

import { Modal } from "@/components/ui/Modal";
import { formatNumber } from "@/lib/format";
import { useTelemetryClient } from "@/services/telemetry-client";
import type { MiningAttemptsResponse } from "@quip/shared/telemetry";
import { SubmissionDetails } from "./SubmissionDetails";

// Modal for a single mining submission: shows the submission summary in
// a dt/dl grid and the per-iteration trail in a table below. Data is
// fetched on demand from the server's proxy (`/api/mining/attempts/:id`)
// because the indexer doesn't persist the iteration array — it can grow
// to thousands of rows per submission and is only relevant when a user
// clicks in for detail. The trade-off: a stopped miner means a stale
// modal; the empty state below makes that explicit.
export function MiningAttemptsModal({
  solutionNumber,
  onClose,
}: {
  solutionNumber: number;
  onClose: () => void;
}) {
  const client = useTelemetryClient();
  const [data, setData] = useState<MiningAttemptsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    client
      .fetchMiningAttempts(solutionNumber, ac.signal)
      .then((env) => setData(env))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [solutionNumber, client]);

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="4xl"
      ariaLabel={`Mining submission ${solutionNumber} details`}
    >
      <Modal.Header>Submission #{formatNumber(solutionNumber)}</Modal.Header>
      <Modal.Body>
        {data && (
          <p className="-mt-2 mb-4 font-accent text-xs text-ink-subtle">
            {data.submission.outcome}
            {data.submission.chainBlockNumber
              ? ` · landed at block #${data.submission.chainBlockNumber}`
              : ""}
          </p>
        )}
        {loading && <p className="font-accent text-sm text-ink-subtle">Fetching from miner…</p>}
        {error && (
          <div className="border border-coral/40 bg-coral/10 p-3">
            <p className="font-accent text-sm text-coral">{error}</p>
            <p className="mt-1 font-accent text-xs text-ink-body">
              The dashboard proxies this through the indexer; if the miner is offline or no
              miner-REST URL has been resolved (no operator descriptor on-chain, validator RPC
              unreachable), the modal can't populate.
            </p>
          </div>
        )}
        {data && <SubmissionDetails envelope={data} />}
      </Modal.Body>
    </Modal>
  );
}
