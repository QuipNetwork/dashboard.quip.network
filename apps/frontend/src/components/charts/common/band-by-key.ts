// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared banding + census scaffolding for the Normalized mode of the
// by-difficulty and by-qblock hooks (use-win-rate-by-difficulty,
// use-mining-time): both slice a sorted item list into ~N equal-count bands
// summarised by an x midpoint, and both need the CPU/GPU/QPU registered-
// device counts to turn a band's raw wins/totals into "average performance of
// one device of that type" for charts/common/normalized-composition.

import type { MinerCategory } from "@quip/shared/telemetry";

export interface Band<T> {
  midpoint: number;
  items: T[];
}

/**
 * Slice a sorted item list into ~numBands equal-count bands, each summarised
 * by the average of `keyOf` over its items (the plotted x).
 */
export function bandByKey<T>(
  sorted: readonly T[],
  numBands: number,
  keyOf: (item: T) => number,
): Band<T>[] {
  const bandSize = Math.max(1, Math.floor(sorted.length / numBands));
  const bands: Band<T>[] = [];
  for (let i = 0; i < sorted.length; i += bandSize) {
    const items = sorted.slice(i, Math.min(i + bandSize, sorted.length));
    if (items.length === 0) continue;
    const midpoint = Math.round(items.reduce((sum, item) => sum + keyOf(item), 0) / items.length);
    bands.push({ midpoint, items });
  }
  return bands;
}

const COMPOSITION_TYPES = ["CPU", "GPU", "QPU"] as const;

/**
 * Registered-device counts per type from the miner-category index — the
 * denominator for "average performance of one device of that type".
 */
export function censusUnitCounts(
  catIndex: ReadonlyMap<string, MinerCategory>,
): Record<(typeof COMPOSITION_TYPES)[number], number> {
  const unitCounts: Record<(typeof COMPOSITION_TYPES)[number], number> = { CPU: 0, GPU: 0, QPU: 0 };
  for (const cat of catIndex.values()) {
    if (cat !== "OTHER") unitCounts[cat]++;
  }
  return unitCounts;
}
