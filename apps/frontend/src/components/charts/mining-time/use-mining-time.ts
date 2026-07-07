// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Range-windowed "Mining per QBlock" series (mirrors the difficulty panel's
// windowing): each range maps to a `since` cutoff served by
// /api/mining-history, whose winner rows define which qblocks fall in the
// window and where they sit on the x-axis. Grouping and metric are local to
// the card — "byType" draws one line per processor type (honouring the global
// type selection), "all" one aggregate line across every type, "normalized"
// the fixed-composition shares from charts/common/normalized-composition. The
// metric is either device access time (seconds) or its estimated electrical
// energy (joules = device watts × seconds).
//
// PARTICIPATION: the per-qblock per-type value is now the TOTAL device time of
// every node that raced the qblock — not just the winner. It comes from
// `aggregateParticipationByQblock(store.participationCompute)`, the
// participant-level join the indexer records per (qblock, participant) across
// all device kinds. The mining-history fetch only bounds the range and orders
// the x-axis; the y-values are the participation totals joined by qblock id.
// Qblocks in range but outside the server's participation window contribute no
// point. Energy uses the category's default device watts (no per-participant
// node is available in the aggregate).

import { useEffect, useMemo, useState } from "react";

import { bandByKey, censusUnitCounts } from "@/components/charts/common/band-by-key";
import {
  buildNormalizedComposition,
  type PerfPoint,
} from "@/components/charts/common/normalized-composition";
import { sinceForRange, type TimeRange } from "@/components/charts/common/time-range";
import { estimateDeviceWatts, estimateEnergyJoules } from "@/lib/hardware-power";
import { buildMinerCategoryIndex } from "@/lib/miner-category";
import { useTelemetryClient } from "@/services/telemetry-client";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import {
  aggregateParticipationByQblock,
  type CategoryCompute,
  type MinerCategory,
  type MiningHistoryRow,
} from "@quip/shared/telemetry";

export type MiningTimeGrouping = "all" | "byType" | "normalized";

export const MINING_TIME_GROUPINGS: ReadonlyArray<{ value: MiningTimeGrouping; label: string }> = [
  { value: "all", label: "All" },
  { value: "byType", label: "By Type" },
  { value: "normalized", label: "Normalized" },
];

export type MiningMetric = "time" | "energy";

export const MINING_METRICS: ReadonlyArray<{ value: MiningMetric; label: string }> = [
  { value: "time", label: "Time" },
  { value: "energy", label: "Energy" },
];

export interface MiningTimeSeries {
  id: string;
  // Display label when it differs from the id ("QPU100" renders as "QPU100%").
  label?: string;
  // x = on-chain qblock id (band midpoint in normalized mode), y = metric
  // value: seconds / joules, or the 0–100 share in normalized mode.
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

// Same banding granularity as Win Rate by Difficulty's normalized mode.
const NUM_BANDS = 12;
const COMPOSITION_TYPES = ["CPU", "GPU", "QPU"] as const;

// One in-range qblock's per-category metric value (device seconds or joules),
// summed across every participant of that category on the qblock.
interface QblockMetric {
  qblockId: number;
  byCat: Partial<Record<MinerCategory, number>>;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

// Normalized mode: band the window's qblocks (ascending id) into ~NUM_BANDS
// equal-count bands, feed each type's per-unit average metric per band into
// the canonical composition model, and plot the resulting shares. Per-unit =
// (type's total participant time/energy in band) / (devices of that type the
// category index knows about) — same census denominator as win-rate's
// normalized mode. The QPU curve is observed under its 20 min/day budget; the
// composition module splits it into QPU20m/QPU100%.
function buildNormalizedSeries(
  records: QblockMetric[],
  unitCounts: Record<(typeof COMPOSITION_TYPES)[number], number>,
): MiningTimeSeries[] {
  const sorted = [...records].sort((a, b) => a.qblockId - b.qblockId);
  const bands = bandByKey(sorted, NUM_BANDS, (r) => r.qblockId);

  const perUnit: Record<(typeof COMPOSITION_TYPES)[number], PerfPoint[]> = {
    CPU: [],
    GPU: [],
    QPU: [],
  };
  for (const band of bands) {
    const totals: Record<(typeof COMPOSITION_TYPES)[number], number> = { CPU: 0, GPU: 0, QPU: 0 };
    for (const r of band.items) {
      for (const type of COMPOSITION_TYPES) totals[type] += r.byCat[type] ?? 0;
    }
    for (const type of COMPOSITION_TYPES) {
      const n = unitCounts[type];
      perUnit[type].push({ x: band.midpoint, y: n > 0 ? totals[type] / n : 0 });
    }
  }

  return buildNormalizedComposition(perUnit).map((s) => ({
    id: s.id,
    label: s.label,
    data: s.data.map((p) => ({ x: p.x, y: round1(p.y) })),
  }));
}

export function useMiningTime(
  range: TimeRange,
  grouping: MiningTimeGrouping,
  metric: MiningMetric = "time",
  opts: { now?: () => number; refreshMs?: number } = {},
): MiningTimeState {
  const client = useTelemetryClient();
  const participationCompute = useTelemetryStore((s) => s.participationCompute);
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
    // Per-qblock per-category totals across every participant (all device
    // kinds), keyed by qblock id.
    const byQblock = aggregateParticipationByQblock(participationCompute);

    // A category's metric value on a qblock: device seconds, or the joules
    // those seconds imply at the category's default device watts.
    const metricForCategory = (c: CategoryCompute): number => {
      if (metric === "time") return c.deviceAccessSeconds;
      return estimateEnergyJoules(estimateDeviceWatts(c.category, null), c.deviceAccessSeconds);
    };

    // The fetched winner rows bound the range and order the x-axis; join each
    // in-range qblock to its participation totals (skip qblocks with none).
    const records: QblockMetric[] = [];
    for (const r of fetched.rows) {
      const cats = byQblock.get(r.qblockId);
      if (!cats || cats.length === 0) continue;
      const byCat: Partial<Record<MinerCategory, number>> = {};
      for (const c of cats) byCat[c.category] = metricForCategory(c);
      records.push({ qblockId: Number(r.qblockId), byCat });
    }

    let series: MiningTimeSeries[];
    if (grouping === "normalized") {
      // The hypothetical composition is fixed (10k CPU / 100 GPU / one QPU in
      // two regimes), so the per-type chips don't apply here — always draw
      // from the whole window.
      const unitCounts = censusUnitCounts(buildMinerCategoryIndex(chainMiners, nodeDescriptors));
      series = records.length > 0 ? buildNormalizedSeries(records, unitCounts) : [];
    } else if (grouping === "all") {
      const points = records.map((r) => ({
        x: r.qblockId,
        y: Object.values(r.byCat).reduce((sum, v) => sum + (v ?? 0), 0),
      }));
      series = points.length > 0 ? [{ id: AGGREGATE_SERIES_ID, data: points }] : [];
    } else {
      const grouped: Record<string, Array<{ x: number; y: number }>> = {};
      for (const r of records) {
        for (const cat of Object.keys(r.byCat) as MinerCategory[]) {
          if (!selectedTypes.includes(cat)) continue;
          (grouped[cat] ??= []).push({ x: r.qblockId, y: r.byCat[cat] ?? 0 });
        }
      }
      series = selectedTypes
        .filter((k) => grouped[k]?.length)
        .map((k) => ({ id: k, data: grouped[k]! }));
    }

    return {
      series,
      loading: fetched.loading,
      error: fetched.error,
      isEmpty: !fetched.loading && series.length === 0,
    };
  }, [
    fetched,
    grouping,
    metric,
    participationCompute,
    chainMiners,
    nodeDescriptors,
    selectedTypes,
  ]);
}
