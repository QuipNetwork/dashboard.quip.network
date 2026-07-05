import { ResponsiveBar } from "@nivo/bar";
import { nivoTheme } from "@/theme/nivo-theme";
import { getSeriesColor } from "@/lib/chart-colors";
import { OverlappingBarsLayer } from "@/components/charts/common/OverlappingBarsLayer";
import { displayLabelForCategory } from "@/components/charts/common/qpu-label";
import type { HistogramData } from "@/lib/histogram";

export interface TimeToSolutionChartProps {
  data: HistogramData;
}

export function TimeToSolutionChart({ data }: TimeToSolutionChartProps) {
  if (data.data.length === 0) return null;

  return (
    <div data-qa="chart-time-to-solution" style={{ width: "100%", height: "100%" }}>
      <ResponsiveBar
        data={data.data}
        keys={data.keys}
        indexBy="bin"
        theme={nivoTheme}
        colors={(bar) => getSeriesColor(String(bar.id))}
        groupMode="grouped"
        margin={{ top: 10, right: 20, bottom: 50, left: 60 }}
        padding={0.15}
        innerPadding={0}
        enableLabel={false}
        enableGridY={true}
        // Default tooltip label is "{id} - {indexValue}" (nivo's BasicTooltip);
        // reroute the id through displayLabelForCategory so "QPU" reads
        // "QPU20m" without a custom tooltip component.
        tooltipLabel={(d) => `${displayLabelForCategory(String(d.id))} - ${d.indexValue}`}
        layers={["grid", "axes", OverlappingBarsLayer, "markers", "legends"]}
        axisBottom={{
          legend: "Time (seconds)",
          legendOffset: 40,
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
            // "QPU" renders as "QPU20m" without touching the series key
            // nivo colors bars/tooltips by.
            data: data.keys.map((k) => ({
              id: k,
              label: displayLabelForCategory(k),
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
