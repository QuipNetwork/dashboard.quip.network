// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Range-windowed /api/mining-history rows, refreshed on an interval. The rows
// bound a chart's window and order its x-axis by qblock id; the y-values come
// from the participation store. Shared by Mining per QBlock and Estimated
// Energy per QBlock.

import { useEffect, useState } from "react";

import { useTelemetryClient } from "@/services/telemetry-client";
import type { MiningHistoryRow } from "@quip/shared/telemetry";

import { sinceForRange, type TimeRange } from "./time-range";

export interface MiningHistoryState {
  rows: MiningHistoryRow[];
  loading: boolean;
  error: string | null;
}

export const MINING_HISTORY_REFRESH_MS = 60_000;

export function useMiningHistory(
  range: TimeRange,
  opts: { now?: () => number; refreshMs?: number } = {},
): MiningHistoryState {
  const client = useTelemetryClient();
  const now = opts.now ?? Date.now;
  const refreshMs = opts.refreshMs ?? MINING_HISTORY_REFRESH_MS;

  const [fetched, setFetched] = useState<MiningHistoryState>({
    rows: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;

    const load = async (): Promise<void> => {
      const since = sinceForRange(range, now());
      try {
        const resp = await client.fetchMiningHistory(since, ac.signal);
        if (cancelled) return;
        setFetched({ rows: resp.rows, loading: false, error: null });
      } catch (err) {
        if (cancelled || ac.signal.aborted) return;
        setFetched((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    };

    setFetched((prev) => ({ ...prev, loading: true, error: null }));
    void load();
    const timer = setInterval(() => void load(), refreshMs);
    return () => {
      cancelled = true;
      ac.abort();
      clearInterval(timer);
    };
  }, [client, range, refreshMs]); // eslint-disable-line react-hooks/exhaustive-deps -- `now` is a stable test seam

  return fetched;
}
