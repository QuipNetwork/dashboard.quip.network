import { useMemo } from "react";
import { useTelemetryStore } from "../store/telemetry-store";
import { getUnitCount } from "../lib/units";
import { buildHistogram, type HistogramData } from "../lib/histogram";

export function useTimeToSolution(): HistogramData {
  const blocks = useTelemetryStore((s) => s.blocks);
  const selectedTypes = useTelemetryStore((s) => s.selectedTypes);

  return useMemo(() => {
    console.log("!!!!", blocks);
    const values = blocks
      .filter((b) => selectedTypes.includes(b.minerCategory) && b.miningTime > 0)
      .map((b) => ({
        value: b.miningTime,
        minerCategory: b.minerCategory,
        unitCount: getUnitCount(b),
      }));

    return buildHistogram(values, selectedTypes);
  }, [blocks, selectedTypes]);
}
