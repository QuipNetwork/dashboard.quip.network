// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Range-windowed "Mining per QBlock" series (mirrors the difficulty panel's
// windowing): each range maps to a `since` cutoff served by
// /api/mining-history, so long windows aren't capped by the telemetry
// store's recent-blocks depth. Grouping and metric are local to the card —
// "byType" draws one line per processor type (honouring the global type
// selection), "all" one aggregate line across every winner, "normalized"
// the fixed-composition shares from charts/common/normalized-composition.
// The metric is either device access time (seconds) or its estimated
// electrical energy (joules = device watts × seconds).
//
// PARTICIPATION HONESTY: the indexer records exactly one row per qblock —
// the WINNING block (`blocks` table; see getMiningHistorySince in
// packages/core/api/db/kysely-adapter.ts). Non-winner participation is not
// recorded anywhere network-wide (`mining_submissions` only covers the
// dashboard's own node, keyed by selfAddress). So nextsteps #8b's "sum of
// all device_access_times of participating nodes" reduces to the winner's
// resolved device time (or energy) per qblock — that is what every mode
// here plots, and the card subtitle says so.

import { useEffect, useMemo, useState } from "react";

import { bandByKey, censusUnitCounts } from "@/components/charts/common/band-by-key";
import {
  buildNormalizedComposition,
  type PerfPoint,
} from "@/components/charts/common/normalized-composition";
import { sinceForRange, type TimeRange } from "@/components/charts/common/time-range";
import { resolveDeviceAccessTime } from "@/lib/device-access-time";
import { estimateDeviceWatts, estimateEnergyJoules } from "@/lib/hardware-power";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useTelemetryClient } from "@/services/telemetry-client";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import type { MinerCategory, MiningHistoryRow, NodeInfo } from "@quip/shared/telemetry";

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

const round1 = (v: number): number => Math.round(v * 10) / 10;

// Normalized mode: band the window's qblocks (ascending id) into ~NUM_BANDS
// equal-count bands, feed each type's per-unit average metric per band into
// the canonical composition model, and plot the resulting shares. Per-unit =
// (type's total winner time/energy in band) / (devices of that type the
// category index knows about) — same census denominator as win-rate's
// normalized mode. The QPU curve is observed under its 20 min/day budget;
// the composition module splits it into QPU20m/QPU100%.
function buildNormalizedSeries(
  rows: MiningHistoryRow[],
  catIndex: ReadonlyMap<string, MinerCategory>,
  metricFor: (row: MiningHistoryRow, cat: MinerCategory) => number,
): MiningTimeSeries[] {
  const unitCounts = censusUnitCounts(catIndex);

  const sorted = [...rows].sort((a, b) => Number(a.qblockId) - Number(b.qblockId));
  const bands = bandByKey(sorted, NUM_BANDS, (r) => Number(r.qblockId));

  const perUnit: Record<(typeof COMPOSITION_TYPES)[number], PerfPoint[]> = {
    CPU: [],
    GPU: [],
    QPU: [],
  };
  for (const band of bands) {
    const totals: Record<(typeof COMPOSITION_TYPES)[number], number> = { CPU: 0, GPU: 0, QPU: 0 };
    for (const r of band.items) {
      const cat = categoryFor(r.minerId, catIndex);
      if (cat === "OTHER") continue;
      totals[cat] += metricFor(r, cat);
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
  const blocks = useTelemetryStore((s) => s.blocks);
  const nodes = useTelemetryStore((s) => s.nodes);
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
    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);

    // Reported deviceAccessTimeUs lives on BlockRecord, not the slim history
    // row — join by qblockId for whatever the recent-blocks window still
    // holds; older rows estimate, which is the normal path
    // (lib/device-access-time).
    const accessUsByQblock = new Map<string, number | null>();
    for (const b of blocks) accessUsByQblock.set(b.qblockId, b.deviceAccessTimeUs);

    // Winner's telemetry node (for its device's watt estimate): chain miner →
    // telemetryNodeAddress → NodesSnapshot entry, when all three line up.
    const nodeByMiner = new Map<string, NodeInfo>();
    if (nodes) {
      for (const m of chainMiners) {
        const node = m.telemetryNodeAddress != null ? nodes.nodes[m.telemetryNodeAddress] : null;
        if (node) nodeByMiner.set(m.accountId, node);
      }
    }

    // Winner's device seconds behind the qblock, or the joules they imply.
    const metricFor = (r: MiningHistoryRow, cat: MinerCategory): number => {
      const { seconds } = resolveDeviceAccessTime(
        { deviceAccessTimeUs: accessUsByQblock.get(r.qblockId) ?? null, miningTime: r.miningTime },
        cat,
      );
      if (metric === "time") return seconds;
      return estimateEnergyJoules(
        estimateDeviceWatts(cat, nodeByMiner.get(r.minerId) ?? null),
        seconds,
      );
    };

    const point = (r: MiningHistoryRow): { x: number; y: number } => ({
      // u64-as-string at the boundary; qblock ids stay far below 2^53.
      x: Number(r.qblockId),
      y: metricFor(r, categoryFor(r.minerId, catIndex)),
    });

    let series: MiningTimeSeries[];
    if (grouping === "normalized") {
      // The hypothetical composition is fixed (10k CPU / 100 GPU / one QPU in
      // two regimes), so the per-type chips don't apply here — always draw
      // from the whole window.
      series =
        fetched.rows.length > 0 ? buildNormalizedSeries(fetched.rows, catIndex, metricFor) : [];
    } else if (grouping === "all") {
      series =
        fetched.rows.length > 0 ? [{ id: AGGREGATE_SERIES_ID, data: fetched.rows.map(point) }] : [];
    } else {
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
  }, [fetched, grouping, metric, blocks, nodes, chainMiners, nodeDescriptors, selectedTypes]);
}
