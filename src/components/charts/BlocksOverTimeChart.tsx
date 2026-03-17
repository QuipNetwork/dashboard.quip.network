import { ResponsiveLine } from "@nivo/line";
import { nivoTheme } from "../../theme/nivo-theme";
import { SERIES_COLORS } from "../../lib/colors";
import { useBlocksOverTime } from "../../hooks/use-blocks-over-time";

export function BlocksOverTimeChart() {
  const data = useBlocksOverTime();

  if (data.length === 0) return null;

  return (
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
  );
}
