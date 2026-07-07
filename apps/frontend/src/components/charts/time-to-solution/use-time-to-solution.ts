// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { filterToBestNodes } from "@/components/charts/mining-time-by-difficulty/mining-cost-model";
import { buildMinerCategoryIndex, categoryFor } from "@/lib/miner-category";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useFilteredBlocks } from "@/store/use-filtered-blocks";
import { useUIStore } from "@/store/ui-store";
import type { NodeScope } from "@/components/charts/common/SegToggle";
import type { HistogramData } from "@/lib/histogram";

// nextsteps.md #4b: fixed 100s-wide buckets — [0,100] is "0-100",
// (100,200] is "101-200", etc.
const BUCKET_WIDTH = 100;

// nextsteps.md #4a: cap the x-domain at the bucket containing the 85th
// percentile of observed mining times (~2000s), so a handful of slow
// outliers don't stretch the axis into a long empty tail. Anything beyond
// that bucket folds into a trailing "> Ns" bucket.
const RANGE_PERCENTILE = 0.85;

// The fixed-width bucket a value falls into: 0 and 100 both land in bucket
// 0 ("0-100"); 101 is the first value in bucket 1 ("101-200").
function bucketIndex(value: number): number {
  return Math.max(0, Math.ceil(value / BUCKET_WIDTH) - 1);
}

function bucketLabel(index: number): string {
  const lo = index === 0 ? 0 : index * BUCKET_WIDTH + 1;
  const hi = (index + 1) * BUCKET_WIDTH;
  return `${lo}-${hi}`;
}

// Nearest-rank percentile (no interpolation) — simple and matches how the
// spec's "~2000 seconds" figure was eyeballed off the raw distribution.
function percentile(sortedAsc: number[], p: number): number {
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}

export interface TimeToSolutionOptions {
  // "best" narrows to each category's single top winner, mirroring the
  // mining-time-by-difficulty definition of "Best Nodes" (nextsteps.md #4c).
  scope?: NodeScope;
}

/**
 * v0.3 transitional: per-block unit counts came from the v0.2 `nodes`
 * snapshot, which no longer exists. Each block contributes a single
 * sample (unitCount=1).
 *
 * Buckets are fixed 100s bins (nextsteps.md #4b) and the x-domain is capped
 * at the 85th percentile of observed mining times (#4a), with anything
 * beyond folded into a trailing "> Ns" bucket rather than stretching the
 * axis for a few outliers.
 */
export function useTimeToSolution(opts: TimeToSolutionOptions = {}): HistogramData {
  const scope = opts.scope ?? "all";
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
    const categoryOf = (minerId: string) => categoryFor(minerId, catIndex);

    const scoped = scope === "best" ? filterToBestNodes(blocks, categoryOf) : blocks;
    const filtered =
      mode === "byType"
        ? scoped.filter((b) => selectedTypes.includes(categoryOf(b.minerId)) && b.miningTime > 0)
        : scoped.filter((b) => b.miningTime > 0);

    if (filtered.length === 0) return { data: [], keys: [] };

    const values = filtered.map((b) => ({
      value: b.miningTime,
      group: mode === "byType" ? categoryOf(b.minerId) : b.minerId,
    }));
    const keys = mode === "byType" ? [...selectedTypes] : [...new Set(values.map((v) => v.group))];

    const sorted = values.map((v) => v.value).sort((a, b) => a - b);
    const lastBucket = bucketIndex(percentile(sorted, RANGE_PERCENTILE));

    const rows: Array<Record<string, string | number>> = [];
    for (let i = 0; i <= lastBucket; i++) {
      const row: Record<string, string | number> = { bin: bucketLabel(i) };
      for (const k of keys) row[k] = 0;
      rows.push(row);
    }
    const overflow: Record<string, string | number> = {
      bin: `> ${(lastBucket + 1) * BUCKET_WIDTH}s`,
    };
    for (const k of keys) overflow[k] = 0;

    let hasOverflow = false;
    for (const v of values) {
      const idx = bucketIndex(v.value);
      if (idx > lastBucket) {
        hasOverflow = true;
        overflow[v.group] = (overflow[v.group] as number) + 1;
      } else {
        const row = rows[idx]!;
        row[v.group] = (row[v.group] as number) + 1;
      }
    }

    return { data: hasOverflow ? [...rows, overflow] : rows, keys: [...keys] };
  }, [blocks, chainMiners, nodeDescriptors, selectedTypes, mode, scope]);
}
