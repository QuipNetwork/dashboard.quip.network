// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Price-panel windowing for the difficulty chart (task #25, spec §10.5).
// Each range maps to a `since` cutoff; the server returns the in-window rows
// plus one anchor row before the cutoff. The series is a step function:
// the anchor pins the prevailing value at the left edge, and the last value
// is extended to "now" so the line always reaches the right edge — no dead
// whitespace regardless of where measurements cluster.

import { useEffect, useState } from "react";

import { useTelemetryClient } from "@/services/telemetry-client";
import type { DifficultyHistoryResponse } from "@quip/shared/telemetry";

export type DifficultyRange = "1h" | "6h" | "12h" | "24h" | "7d" | "1m" | "ytd" | "all";

export const DIFFICULTY_RANGES: ReadonlyArray<{ value: DifficultyRange; label: string }> = [
  { value: "1h", label: "1H" },
  { value: "6h", label: "6H" },
  { value: "12h", label: "12H" },
  { value: "24h", label: "24H" },
  { value: "7d", label: "7D" },
  { value: "1m", label: "1M" },
  { value: "ytd", label: "YTD" },
  { value: "all", label: "ALL" },
];

const HOUR_MS = 3_600_000;
const FIXED_WINDOW_MS: Partial<Record<DifficultyRange, number>> = {
  "1h": HOUR_MS,
  "6h": 6 * HOUR_MS,
  "12h": 12 * HOUR_MS,
  "24h": 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
  "1m": 30 * 24 * HOUR_MS,
};

/** The window's ISO cutoff for a range, evaluated at `nowMs`. */
export function sinceForRange(range: DifficultyRange, nowMs: number): string {
  const fixed = FIXED_WINDOW_MS[range];
  if (fixed !== undefined) return new Date(nowMs - fixed).toISOString();
  if (range === "ytd") {
    return new Date(Date.UTC(new Date(nowMs).getUTCFullYear(), 0, 1)).toISOString();
  }
  // "all": the epoch — the server returns everything from the first
  // measurement, and the chart's x-min follows the first point.
  return new Date(0).toISOString();
}

export interface SeriesPoint {
  x: Date;
  y: number;
}

/**
 * Response → step-series points. The anchor (prevailing value before the
 * window) becomes the point AT the window start; the last known value is
 * extended to `nowMs` so the step reaches the right edge.
 */
export function buildSeriesPoints(resp: DifficultyHistoryResponse, nowMs: number): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  if (resp.anchor) points.push({ x: new Date(resp.since), y: resp.anchor.difficultyEnergy });
  for (const r of resp.rows) points.push({ x: new Date(r.observedAt), y: r.difficultyEnergy });
  const last = points[points.length - 1];
  if (last && last.x.getTime() < nowMs) points.push({ x: new Date(nowMs), y: last.y });
  return points;
}

export interface DifficultyHistoryState {
  points: SeriesPoint[];
  // The window start as a Date for the x-scale min ("all" uses the first
  // point instead, so charts never open with dead space).
  windowStart: Date | null;
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
}

const REFRESH_MS = 60_000;

export function useDifficultyHistory(
  range: DifficultyRange,
  opts: { now?: () => number; refreshMs?: number } = {},
): DifficultyHistoryState {
  const client = useTelemetryClient();
  const now = opts.now ?? Date.now;
  const refreshMs = opts.refreshMs ?? REFRESH_MS;
  const [state, setState] = useState<DifficultyHistoryState>({
    points: [],
    windowStart: null,
    loading: true,
    error: null,
    isEmpty: false,
  });

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;

    const load = async (): Promise<void> => {
      const nowMs = now();
      const since = sinceForRange(range, nowMs);
      try {
        const resp = await client.fetchDifficultyHistory(since, ac.signal);
        if (cancelled) return;
        const points = buildSeriesPoints(resp, nowMs);
        setState({
          points,
          windowStart: range === "all" ? (points[0]?.x ?? null) : new Date(since),
          loading: false,
          error: null,
          isEmpty: points.length === 0,
        });
      } catch (err) {
        if (cancelled || ac.signal.aborted) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    };

    setState((prev) => ({ ...prev, loading: true, error: null }));
    void load();
    const timer = setInterval(() => void load(), refreshMs);
    return () => {
      cancelled = true;
      ac.abort();
      clearInterval(timer);
    };
  }, [client, range, refreshMs]); // eslint-disable-line react-hooks/exhaustive-deps -- `now` is a stable test seam

  return state;
}
