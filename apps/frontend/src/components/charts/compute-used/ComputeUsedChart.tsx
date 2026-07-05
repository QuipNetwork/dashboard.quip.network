import { ResponsiveBar } from "@nivo/bar";
import { nivoTheme } from "@/theme/nivo-theme";
import { getSeriesColor } from "@/lib/chart-colors";
import { labelForCategoryWith, useQpuDisplayLabel } from "@/components/charts/common/qpu-label";
import { formatSeconds } from "@/lib/format";
import type { ComputeUsedEntry } from "./use-compute-used";

export interface ComputeUsedChartProps {
  data: ComputeUsedEntry[];
}

export function ComputeUsedChart({ data }: ComputeUsedChartProps) {
  const qpuLabel = useQpuDisplayLabel();
  if (data.length === 0) return null;

  const labelFor = labelForCategoryWith(qpuLabel);

  // Nivo only ever plots `displayCompute` (possibly floored for visibility,
  // see use-compute-used.ts) and needs `minerType` as the index key — that's
  // all `bars` carries. The true `compute`/`estimated`/`floored` fields are
  // read back out of `data` by minerType inside label/tooltip below, so
  // labels and tooltips always report the real value, never the floor.
  const byType = new Map(data.map((d) => [d.minerType, d]));
  const bars = data.map((d) => ({ minerType: d.minerType, displayCompute: d.displayCompute }));

  const describe = (minerType: string) => {
    const entry = byType.get(minerType);
    if (!entry) return "";
    return `${entry.estimated ? "~" : ""}${formatSeconds(entry.compute)}`;
  };

  return (
    <div data-qa="chart-compute-used" style={{ width: "100%", height: "100%" }}>
      <ResponsiveBar
        data={bars}
        keys={["displayCompute"]}
        indexBy="minerType"
        theme={nivoTheme}
        colors={(bar) => getSeriesColor(String(bar.indexValue))}
        margin={{ top: 20, right: 20, bottom: 40, left: 70 }}
        padding={0.4}
        axisLeft={{
          legend: "Compute used",
          legendOffset: -60,
          legendPosition: "middle",
          format: (v) => formatSeconds(Number(v)),
        }}
        axisBottom={{ format: (v) => labelFor(String(v)) }}
        label={(d) => describe(String(d.indexValue))}
        tooltip={({ indexValue }) => {
          const entry = byType.get(String(indexValue));
          if (!entry) return null;
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
              <div>{describe(entry.minerType)}</div>
              {entry.floored && (
                <div style={{ color: "#71717B", marginTop: 2 }}>
                  bar height floored for visibility
                </div>
              )}
            </div>
          );
        }}
      />
    </div>
  );
}
