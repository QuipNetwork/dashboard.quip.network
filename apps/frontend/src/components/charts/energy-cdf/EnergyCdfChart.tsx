import { ResponsiveLine } from "@nivo/line";
import { nivoTheme } from "@/theme/nivo-theme";
import { SERIES_GRADIENT } from "@/lib/colors";
import { getSeriesColor } from "@/lib/chart-colors";
import { createGradientLines } from "@/components/charts/common/GradientLines";
import { createLineTooltip } from "@/components/charts/common/LineTooltip";
import type { EnergyCdfResult } from "./use-energy-cdf";

const tooltip = createLineTooltip({
  xLabel: "Energy Threshold",
  yLabel: "Probability",
  yFormat: (v) => `${v.toFixed(1)}%`,
});

const gradientLines = createGradientLines(
  Object.fromEntries(
    Object.entries(SERIES_GRADIENT).map(([id, [from, to]]) => [
      id,
      [
        { offset: "0%", color: from },
        { offset: "100%", color: to },
      ],
    ]),
  ),
);

export interface EnergyCdfChartProps {
  data: EnergyCdfResult;
}

export function EnergyCdfChart({ data }: EnergyCdfChartProps) {
  const { series, xMin, xMax } = data;
  if (series.length === 0) return null;

  return (
    <div data-qa="chart-energy-cdf" style={{ width: "100%", height: "100%" }}>
      <ResponsiveLine
        data={series}
        theme={nivoTheme}
        colors={(s) => getSeriesColor(String(s.id))}
        margin={{ top: 20, right: 20, bottom: 50, left: 60 }}
        xScale={{ type: "linear", min: xMin, max: xMax }}
        yScale={{ type: "linear", min: 0, max: 100, stacked: false }}
        curve="monotoneX"
        enableArea={true}
        areaOpacity={0.08}
        enablePoints={false}
        lineWidth={2}
        layers={[
          "grid",
          "markers",
          "axes",
          "areas",
          "crosshair",
          gradientLines,
          "slices",
          "points",
          "mesh",
          "legends",
        ]}
        axisBottom={{
          legend: "Difficulty Threshold (Energy)",
          legendOffset: 40,
          legendPosition: "middle",
        }}
        axisLeft={{
          legend: "Probability (%)",
          legendOffset: -50,
          legendPosition: "middle",
        }}
        tooltip={tooltip}
        useMesh={true}
        enableCrosshair={true}
        legends={
          series.length <= 5
            ? [
                {
                  anchor: "top-left",
                  direction: "row",
                  itemWidth: 70,
                  itemHeight: 20,
                  symbolSize: 10,
                  symbolShape: "circle",
                  translateY: -15,
                },
              ]
            : []
        }
      />
    </div>
  );
}
