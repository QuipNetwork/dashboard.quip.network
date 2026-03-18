import { useMemo } from "react";
import { useTelemetryStore } from "../store/telemetry-store";
import { getUnitCount } from "../lib/units";
import { buildHistogram, type HistogramData } from "../lib/histogram";

export function useEnergyDistribution(): HistogramData {
  const blocks = useTelemetryStore((s) => s.blocks);
  const selectedTypes = useTelemetryStore((s) => s.selectedTypes);

  return useMemo(() => {
    const values = blocks
      .filter((b) => selectedTypes.includes(b.minerCategory))
      .map((b) => ({
        value: b.energy,
        minerCategory: b.minerCategory,
        unitCount: getUnitCount(b),
      }));

    return buildHistogram(values, selectedTypes);
  }, [blocks, selectedTypes]);
}
