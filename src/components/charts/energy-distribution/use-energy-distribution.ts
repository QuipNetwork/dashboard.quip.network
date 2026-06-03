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
 * sample to the histogram (unitCount=1) until per-miner hardware lands
 * via peer-query.
 */
export function useEnergyDistribution(): HistogramData {
  const blocks = useFilteredBlocks();
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const catIndex = buildMinerCategoryIndex(chainMiners, nodeDescriptors);
    const filtered =
      mode === "byType"
        ? blocks.filter((b) => selectedTypes.includes(categoryFor(b.minerId, catIndex)))
        : blocks;

    const values = filtered.map((b) => ({
      value: b.energy,
      group: mode === "byType" ? categoryFor(b.minerId, catIndex) : b.minerId,
      unitCount: 1,
    }));

    const keys = mode === "byType" ? [...selectedTypes] : [...new Set(values.map((v) => v.group))];

    return buildHistogram(values, keys);
  }, [blocks, chainMiners, nodeDescriptors, selectedTypes, mode]);
}
