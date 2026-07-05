import { ResponsiveLine } from "@nivo/line";
import { nivoTheme } from "@/theme/nivo-theme";
import { SERIES_GRADIENT } from "@/lib/colors";
import { getSeriesColor } from "@/lib/chart-colors";
import { createGradientLines } from "@/components/charts/common/GradientLines";
import { createLineTooltip } from "@/components/charts/common/LineTooltip";
import type { BlocksOverTimeSeries } from "./use-blocks-over-time";

const tooltip = createLineTooltip({
  xLabel: "Time (min)",
  yLabel: "Blocks",
});

export interface BlocksOverTimeChartProps {
  data: BlocksOverTimeSeries[];
  // Left-axis legend; defaults to the cumulative-count wording used by the
  // "By Type"/"By Node" presentations. `BlocksOverTimeCard`'s Normalized
  // mode overrides it to the per-device wording.
  yAxisLabel?: string;
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

export function BlocksOverTimeChart({
  data,
  yAxisLabel = "Cumulative QBlocks",
}: BlocksOverTimeChartProps) {
  if (data.length === 0) return null;

  return (
    <div data-qa="chart-blocks-over-time" style={{ width: "100%", height: "100%" }}>
      <ResponsiveLine
        data={data}
        theme={nivoTheme}
        colors={(series) => getSeriesColor(String(series.id))}
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
          legend: yAxisLabel,
          legendOffset: -50,
          legendPosition: "middle",
        }}
        tooltip={tooltip}
        useMesh={true}
        enableCrosshair={true}
        legends={
          data.length <= 5
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
