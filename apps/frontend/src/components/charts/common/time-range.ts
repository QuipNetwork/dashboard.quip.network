// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Price-panel time windows shared by the range-selectable charts (difficulty,
// mining time). Each range maps to a `since` ISO cutoff the server filters on.

export type TimeRange = "1h" | "6h" | "12h" | "24h" | "7d" | "1m" | "ytd" | "all";

export const TIME_RANGES: ReadonlyArray<{ value: TimeRange; label: string }> = [
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
const FIXED_WINDOW_MS: Partial<Record<TimeRange, number>> = {
  "1h": HOUR_MS,
  "6h": 6 * HOUR_MS,
  "12h": 12 * HOUR_MS,
  "24h": 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
  "1m": 30 * 24 * HOUR_MS,
};

/** The window's ISO cutoff for a range, evaluated at `nowMs`. */
export function sinceForRange(range: TimeRange, nowMs: number): string {
  const fixed = FIXED_WINDOW_MS[range];
  if (fixed !== undefined) return new Date(nowMs - fixed).toISOString();
  if (range === "ytd") {
    return new Date(Date.UTC(new Date(nowMs).getUTCFullYear(), 0, 1)).toISOString();
  }
  // "all": the epoch — the server returns everything from the first
  // measurement, and the chart's x-min follows the first point.
  return new Date(0).toISOString();
}
