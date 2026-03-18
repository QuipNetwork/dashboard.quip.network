import { ResponsiveLine } from "@nivo/line";
import { nivoTheme } from "../../../theme/nivo-theme";
import { SERIES_GRADIENT } from "../../../lib/colors";
import { getSeriesColor } from "../../../lib/chart-colors";
import { createGradientLines } from "../common/GradientLines";
import { createLineTooltip } from "../common/LineTooltip";
import type { MiningTimeSeries } from "./use-mining-time";

const tooltip = createLineTooltip({
  xLabel: "Block",
  yLabel: "Mining Time",
  yFormat: (v) => `${v.toFixed(1)}s`,
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

export interface MiningTimeChartProps {
  data: MiningTimeSeries[];
}

export function MiningTimeChart({ data }: MiningTimeChartProps) {
  if (data.length === 0) return null;

  return (
    <div data-qa="chart-mining-time" style={{ width: "100%", height: "100%" }}>
    <ResponsiveLine
      data={data}
      theme={nivoTheme}
      colors={(series) => getSeriesColor(String(series.id))}
      margin={{ top: 20, right: 20, bottom: 50, left: 60 }}
      xScale={{ type: "linear" }}
      yScale={{ type: "linear", min: 0, stacked: false }}
      curve="monotoneX"
      enablePoints={true}
      pointSize={4}
      pointBorderWidth={1}
      pointBorderColor={{ from: "serieColor" }}
      pointColor="#1A1A1A"
      lineWidth={2}
      layers={[
        "grid",
        "markers",
        "axes",
        "crosshair",
        gradientLines,
        "slices",
        "points",
        "mesh",
        "legends",
      ]}
      axisBottom={{
        legend: "Block Index",
        legendOffset: 40,
        legendPosition: "middle",
      }}
      axisLeft={{
        legend: "Mining Time (seconds)",
        legendOffset: -50,
        legendPosition: "middle",
      }}
      tooltip={tooltip}
      useMesh={true}
      enableCrosshair={true}
      legends={data.length <= 5 ? [
        {
          anchor: "top-left",
          direction: "row",
          itemWidth: 70,
          itemHeight: 20,
          symbolSize: 10,
          symbolShape: "circle",
          translateY: -15,
        },
      ] : []}
    />
    </div>
  );
}
