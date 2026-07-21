// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";

import { ChartCard } from "@/components/layout/ChartCard";
import { SegmentedControl } from "@/components/charts/common/SegmentedControl";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import { BlocksOverTimeChart } from "./BlocksOverTimeChart";
import { countDevicesByType, normalizeSeriesByDeviceCount } from "./device-counts";
import { useBlocksOverTime } from "./use-blocks-over-time";

export type BlocksOverTimePresentation = "byType" | "normalized";

const PRESENTATION_OPTIONS: ReadonlyArray<{
  value: BlocksOverTimePresentation;
  label: string;
}> = [
  { value: "byType", label: "By Type" },
  { value: "normalized", label: "Normalized" },
];

/**
 * "QBlocks Mined Over Time" card — wraps `useBlocksOverTime` + the chart in
 * its own `ChartCard`, plus a card-local "By Type | Normalized" toggle.
 * Normalized divides each type's cumulative series by its registered
 * device count (nextsteps.md #9); see `device-counts.ts` for the counting
 * rule.
 *
 * Normalization is a per-*type* presentation, so it only makes sense when
 * the global aggregation mode is "byType" (see `ComputeAvailableView.tsx`'s
 * byType/byNode subtitle ternaries for the split this mirrors). In "byNode"
 * mode the series are per-miner, not per-type, so there's no device
 * denominator to divide by — the toggle is hidden rather than shown
 * disabled, since there's nothing for the operator to choose between.
 */
export function BlocksOverTimeCard() {
  const [presentation, setPresentation] = useState<BlocksOverTimePresentation>("byType");
  const byType = useUIStore((s) => s.aggregationMode) === "byType";
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const series = useBlocksOverTime();

  const deviceCounts = useMemo(() => countDevicesByType(nodeDescriptors), [nodeDescriptors]);
  const normalized = byType && presentation === "normalized";
  const displaySeries = useMemo(
    () => (normalized ? normalizeSeriesByDeviceCount(series, deviceCounts) : series),
    [normalized, series, deviceCounts],
  );

  return (
    <ChartCard
      title="QBlocks Mined Over Time"
      subtitle={
        !byType
          ? "Cumulative qblocks per miner"
          : normalized
            ? "Cumulative qblocks per registered device"
            : "Cumulative qblocks per unit type"
      }
      actions={
        byType ? (
          <SegmentedControl
            options={PRESENTATION_OPTIONS}
            value={presentation}
            onChange={setPresentation}
            ariaLabel="QBlocks over time presentation"
          />
        ) : undefined
      }
    >
      <BlocksOverTimeChart
        data={displaySeries}
        yAxisLabel={normalized ? "QBlocks per device" : "Cumulative QBlocks"}
      />
    </ChartCard>
  );
}
