// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Range-windowed mining-time series (mirrors the difficulty panel's
// windowing): each range maps to a `since` cutoff served by
// /api/mining-history, so long windows aren't capped by the telemetry
// store's recent-blocks depth. Grouping is local to the card — "byType"
// draws one line per processor type (honouring the global type selection),
// "all" one aggregate line across every winner.

import { useEffect, useMemo, useState } from "react";

import { sinceForRange, type TimeRange } from "@/components/charts/common/time-range";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useTelemetryClient } from "@/services/telemetry-client";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import type { MiningHistoryRow } from "@quip/shared/telemetry";

export type MiningTimeGrouping = "all" | "byType";

export const MINING_TIME_GROUPINGS: ReadonlyArray<{ value: MiningTimeGrouping; label: string }> = [
  { value: "all", label: "All" },
  { value: "byType", label: "By Type" },
];

export interface MiningTimeSeries {
  id: string;
  // x = on-chain qblock id (monotonic win counter), y = mining time seconds.
  data: Array<{ x: number; y: number }>;
}

export interface MiningTimeState {
  series: MiningTimeSeries[];
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
}

const REFRESH_MS = 60_000;
export const AGGREGATE_SERIES_ID = "All";

export function useMiningTime(
  range: TimeRange,
  grouping: MiningTimeGrouping,
  opts: { now?: () => number; refreshMs?: number } = {},
): MiningTimeState {
  const client = useTelemetryClient();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const now = opts.now ?? Date.now;
  const refreshMs = opts.refreshMs ?? REFRESH_MS;

  const [fetched, setFetched] = useState<{
    rows: MiningHistoryRow[];
    loading: boolean;
    error: string | null;
  }>({ rows: [], loading: true, error: null });

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

  return useMemo(() => {
    const point = (r: MiningHistoryRow): { x: number; y: number } => ({
      // u64-as-string at the boundary; qblock ids stay far below 2^53.
      x: Number(r.qblockId),
      y: r.miningTime,
    });

    let series: MiningTimeSeries[];
    if (grouping === "all") {
      series =
        fetched.rows.length > 0 ? [{ id: AGGREGATE_SERIES_ID, data: fetched.rows.map(point) }] : [];
    } else {
      const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
      const grouped: Record<string, Array<{ x: number; y: number }>> = {};
      for (const r of fetched.rows) {
        const cat = categoryFor(r.minerId, catIndex);
        if (!selectedTypes.includes(cat)) continue;
        (grouped[cat] ??= []).push(point(r));
      }
      series = selectedTypes
        .filter((k) => grouped[k]?.length)
        .map((k) => ({
          id: k,
          data: grouped[k]!,
        }));
    }

    return {
      series,
      loading: fetched.loading,
      error: fetched.error,
      isEmpty: !fetched.loading && series.length === 0,
    };
  }, [fetched, grouping, chainMiners, nodeDescriptors, selectedTypes]);
}
