// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";

import type { NodeLiveData } from "@quip/shared/telemetry";
import { useTelemetryClient } from "@/services/telemetry-client";
import { useTelemetryStore } from "@/store/telemetry-store";

export type NodeLiveStatus = "loading" | "ok" | "unreachable";

export interface NodeLiveState {
  status: NodeLiveStatus;
  data: NodeLiveData | null;
}

/**
 * Fetches a peer's on-demand live snapshot (`/api/node/:accountId/live`) and
 * exposes a small state machine: `loading` → `ok` (reachable) | `unreachable`
 * (connect failure or the proxy reported `reachable:false`). Re-fetches when the
 * account or the current global problem number changes. Aborts in-flight
 * requests on unmount / account switch so a slow peer can't clobber fresh state.
 */
export function useNodeLiveData(accountId: string): NodeLiveState {
  const client = useTelemetryClient();
  const chainHead = useTelemetryStore((s) => s.chainHead);
  // The in-flight global problem = qblockCount + 1; drives the dispatch probe.
  const problem = chainHead?.qblockCount != null ? chainHead.qblockCount + 1 : null;

  const [state, setState] = useState<NodeLiveState>({ status: "loading", data: null });

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: "loading", data: null });
    client
      .fetchNodeLive(accountId, problem, ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setState({ status: data.reachable ? "ok" : "unreachable", data });
      })
      .catch(() => {
        if (ctrl.signal.aborted) return;
        setState({ status: "unreachable", data: null });
      });
    return () => ctrl.abort();
  }, [accountId, problem, client]);

  return state;
}
