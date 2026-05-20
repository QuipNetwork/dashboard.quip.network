// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { buildMinerCategoryIndex, categoryFor } from "../../../lib/miner-category";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useFilteredBlocks } from "../../../store/use-filtered-blocks";
import { useUIStore } from "../../../store/ui-store";
import { buildHistogram, type HistogramData } from "../../../lib/histogram";

/**
 * v0.3 transitional: per-block unit counts came from the v0.2 `nodes`
 * snapshot, which no longer exists. Each block contributes a single
 * sample (unitCount=1).
 */
export function useTimeToSolution(): HistogramData {
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const catIndex = buildMinerCategoryIndex(chainMiners);
    const filtered =
      mode === "byType"
        ? blocks.filter(
            (b) => selectedTypes.includes(categoryFor(b.minerId, catIndex)) && b.miningTime > 0,
          )
        : blocks.filter((b) => b.miningTime > 0);

    const values = filtered.map((b) => ({
      value: b.miningTime,
      group: mode === "byType" ? categoryFor(b.minerId, catIndex) : b.minerId,
      unitCount: 1,
    }));

    const keys = mode === "byType" ? [...selectedTypes] : [...new Set(values.map((v) => v.group))];

    return buildHistogram(values, keys);
  }, [blocks, chainMiners, selectedTypes, mode]);
}
