import { ResponsivePie } from "@nivo/pie";
import { nivoTheme } from "@/theme/nivo-theme";
import { getSeriesColor } from "@/lib/chart-colors";
import { labelForCategoryWith, useQpuDisplayLabel } from "@/components/charts/common/qpu-label";
import { formatSeconds } from "@/lib/format";
import type { ComputeUsedEntry } from "./use-compute-used";

export interface ComputeUsedChartProps {
  data: ComputeUsedEntry[];
}

interface Slice {
  id: string;
  label: string;
  value: number;
  entry: ComputeUsedEntry;
}

export function ComputeUsedChart({ data }: ComputeUsedChartProps) {
  const qpuLabel = useQpuDisplayLabel();
  if (data.length === 0) return null;

  const labelFor = labelForCategoryWith(qpuLabel);

  // Nivo only ever plots `value` (= displayCompute, possibly floored for
  // visibility, see use-compute-used.ts). The true `compute`/`estimated`/
  // `floored` fields ride along on `entry`, read back inside the tooltip so
  // labels always report the real value, never the floor.
  const slices: Slice[] = data.map((d) => ({
    id: d.minerType,
    label: labelFor(d.minerType),
    value: d.displayCompute,
    entry: d,
  }));

  const describe = (entry: ComputeUsedEntry): string =>
    `${entry.estimated ? "~" : ""}${formatSeconds(entry.compute)}`;

  return (
    <div data-qa="chart-compute-used" style={{ width: "100%", height: "100%" }}>
      <ResponsivePie
        data={slices}
        theme={nivoTheme}
        colors={(d) => getSeriesColor(String(d.id))}
        margin={{ top: 30, right: 80, bottom: 30, left: 80 }}
        innerRadius={0.5}
        padAngle={2}
        cornerRadius={4}
        borderWidth={1}
        borderColor={{ from: "color", modifiers: [["darker", 0.6]] }}
        arcLinkLabelsColor={{ from: "color" }}
        arcLinkLabelsTextColor="#27272a"
        arcLinkLabelsThickness={2}
        arcLabel={(d) => describe((d.data as Slice).entry)}
        arcLabelsTextColor="#1A1A1A"
        activeOuterRadiusOffset={8}
        tooltip={({ datum }) => {
          const { entry } = datum.data as Slice;
          return (
            <div
              style={{
                background: "#ffffff",
                border: "1px solid #d4d4d8",
                borderRadius: 6,
                padding: "8px 12px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                fontFamily: "'ABC Favotit Mono', monospace",
                fontSize: 12,
                color: "#27272a",
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{labelFor(entry.minerType)}</div>
              <div>{describe(entry)}</div>
              {entry.floored && (
                <div style={{ color: "#71717B", marginTop: 2 }}>
                  slice size floored for visibility
                </div>
              )}
            </div>
          );
        }}
      />
    </div>
  );
}
