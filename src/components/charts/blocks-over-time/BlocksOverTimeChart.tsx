import { ResponsiveLine } from "@nivo/line";
import { nivoTheme } from "../../../theme/nivo-theme";
import { SERIES_COLORS, SERIES_GRADIENT } from "../../../lib/colors";
import { createGradientLines } from "../common/GradientLines";
import type { BlocksOverTimeSeries } from "./use-blocks-over-time";

export interface BlocksOverTimeChartProps {
  data: BlocksOverTimeSeries[];
}

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

export function BlocksOverTimeChart({ data }: BlocksOverTimeChartProps) {
  if (data.length === 0) return null;

  return (
    <div data-qa="chart-blocks-over-time" style={{ width: "100%", height: "100%" }}>
    <ResponsiveLine
      data={data}
      theme={nivoTheme}
      colors={(series) => SERIES_COLORS[series.id as keyof typeof SERIES_COLORS] ?? "#999"}
      margin={{ top: 20, right: 20, bottom: 50, left: 60 }}
      xScale={{ type: "linear" }}
      yScale={{ type: "linear", min: 0, stacked: false }}
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
        legend: "Time (minutes)",
        legendOffset: 40,
        legendPosition: "middle",
      }}
      axisLeft={{
        legend: "Cumulative Blocks",
        legendOffset: -50,
        legendPosition: "middle",
      }}
      useMesh={true}
      enableCrosshair={true}
      legends={[
        {
          anchor: "top-left",
          direction: "row",
          itemWidth: 70,
          itemHeight: 20,
          symbolSize: 10,
          symbolShape: "circle",
          translateY: -15,
        },
      ]}
    />
    </div>
  );
}
