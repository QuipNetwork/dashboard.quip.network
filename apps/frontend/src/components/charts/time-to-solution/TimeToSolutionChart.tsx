import { ResponsiveBar } from "@nivo/bar";
import { nivoTheme } from "@/theme/nivo-theme";
import { getSeriesColor } from "@/lib/chart-colors";
import { OverlappingBarsLayer } from "@/components/charts/common/OverlappingBarsLayer";
import { labelForCategoryWith, useQpuDisplayLabel } from "@/components/charts/common/qpu-label";
import type { HistogramData } from "@/lib/histogram";

export interface TimeToSolutionChartProps {
  data: HistogramData;
}

export function TimeToSolutionChart({ data }: TimeToSolutionChartProps) {
  const qpuLabel = useQpuDisplayLabel();
  if (data.data.length === 0) return null;

  const labelFor = labelForCategoryWith(qpuLabel);

  return (
    <div data-qa="chart-time-to-solution" style={{ width: "100%", height: "100%" }}>
      <ResponsiveBar
        data={data.data}
        keys={data.keys}
        indexBy="bin"
        theme={nivoTheme}
        colors={(bar) => getSeriesColor(String(bar.id))}
        groupMode="grouped"
        margin={{ top: 10, right: 20, bottom: 58, left: 60 }}
        padding={0.15}
        innerPadding={0}
        enableLabel={false}
        enableGridY={true}
        // Default tooltip label is "{id} - {indexValue}" (nivo's BasicTooltip);
        // reroute the id through labelFor so "QPU" reads under the live
        // budget label without a custom tooltip component.
        tooltipLabel={(d) => `${labelFor(String(d.id))} - ${d.indexValue}`}
        layers={["grid", "axes", OverlappingBarsLayer, "markers", "legends"]}
        axisBottom={{
          legend: "Time (seconds)",
          // Sits below the -45° rotated tick labels; a larger offset (with the
          // widened bottom margin) drops the title clear of the ticks (ssf.7).
          legendOffset: 48,
          legendPosition: "middle",
          tickRotation: -45,
        }}
        axisLeft={{
          legend: "Frequency / Unit",
          legendOffset: -50,
          legendPosition: "middle",
        }}
        legends={[
          {
            dataFrom: "keys",
            // Explicit `data` overrides the dataFrom-derived default so
            // "QPU" renders under the live budget label without touching the series key
            // nivo colors bars/tooltips by.
            data: data.keys.map((k) => ({
              id: k,
              label: labelFor(k),
              color: getSeriesColor(k),
            })),
            anchor: "top-right",
            direction: "column",
            itemWidth: 60,
            itemHeight: 18,
            symbolSize: 10,
            symbolShape: "square",
          },
        ]}
      />
    </div>
  );
}
