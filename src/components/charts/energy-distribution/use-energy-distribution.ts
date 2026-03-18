import { useMemo } from "react";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useUIStore } from "../../../store/ui-store";
import { getUnitCount } from "../../../lib/units";
import { buildHistogram, type HistogramData } from "../../../lib/histogram";

export function useEnergyDistribution(): HistogramData {
  const blocks = useTelemetryStore((s) => s.blocks);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const filtered =
      mode === "byType"
        ? blocks.filter((b) => selectedTypes.includes(b.minerCategory))
        : blocks;

    const values = filtered.map((b) => ({
      value: b.energy,
      group: mode === "byType" ? b.minerCategory : b.minerId,
      unitCount: getUnitCount(b),
    }));

    const keys =
      mode === "byType" ? [...selectedTypes] : [...new Set(values.map((v) => v.group))];

    return buildHistogram(values, keys);
  }, [blocks, selectedTypes, mode]);
}
