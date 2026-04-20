import { useMemo } from "react";
import { useTelemetryStore } from "../../../store/telemetry-store";
import { useUIStore } from "../../../store/ui-store";
import { buildUnitCountIndex, getUnitCount } from "../../../lib/units";
import { buildHistogram, type HistogramData } from "../../../lib/histogram";

export function useTimeToSolution(): HistogramData {
  const blocks = useTelemetryStore((s) => s.blocks);
  const nodes = useTelemetryStore((s) => s.nodes);
  const selectedTypes = useUIStore((s) => s.selectedTypes);
  const mode = useUIStore((s) => s.aggregationMode);

  return useMemo(() => {
    const unitIndex = buildUnitCountIndex(nodes);
    const filtered =
      mode === "byType"
        ? blocks.filter((b) => selectedTypes.includes(b.minerCategory) && b.miningTime > 0)
        : blocks.filter((b) => b.miningTime > 0);

    const values = filtered.map((b) => ({
      value: b.miningTime,
      group: mode === "byType" ? b.minerCategory : b.minerId,
      unitCount: getUnitCount(b, unitIndex),
    }));

    const keys = mode === "byType" ? [...selectedTypes] : [...new Set(values.map((v) => v.group))];

    return buildHistogram(values, keys);
  }, [blocks, nodes, selectedTypes, mode]);
}
