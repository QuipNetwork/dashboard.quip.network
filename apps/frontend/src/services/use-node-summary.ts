// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One node's stored win summary from `GET /api/node/{account}/summary`,
// fetched each time a node page opens. The last answer is kept in IndexedDB
// and shown until the fresh one arrives.

import { useEffect, useState } from "react";

import { indexedDbNodeSummaryCache, type NodeSummaryCache } from "@/services/node-summary-cache";
import { useTelemetryClient } from "@/services/telemetry-client";
import type { NodeSummaryResponse } from "@quip/shared/telemetry";

export interface NodeSummaryState extends NodeSummaryResponse {
  // True until the backend has answered for this account.
  loading: boolean;
  error: string | null;
}

const EMPTY: NodeSummaryResponse = { summary: null, lastWonBlock: null };

export function useNodeSummary(
  accountId: string | null,
  cache: NodeSummaryCache = indexedDbNodeSummaryCache,
): NodeSummaryState {
  const client = useTelemetryClient();
  const [state, setState] = useState<NodeSummaryState>({
    ...EMPTY,
    loading: accountId !== null,
    error: null,
  });

  useEffect(() => {
    setState({ ...EMPTY, loading: accountId !== null, error: null });
    if (accountId === null) return;
    const ac = new AbortController();
    let fresh = false;

    void cache.read(accountId).then((cached) => {
      if (cached !== null && !fresh && !ac.signal.aborted) {
        setState({ ...cached, loading: true, error: null });
      }
    });

    client
      .fetchNodeSummary(accountId, ac.signal)
      .then((response) => {
        if (ac.signal.aborted) return;
        fresh = true;
        setState({ ...response, loading: false, error: null });
        void cache.write(accountId, response);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      });

    return () => ac.abort();
  }, [client, cache, accountId]);

  return state;
}
