import { ResponsiveLine } from "@nivo/line";
import { nivoTheme } from "../../theme/nivo-theme";
import { SERIES_COLORS } from "../../lib/colors";
import { useMiningTime } from "../../hooks/use-mining-time";

export function MiningTimeChart() {
  const data = useMiningTime();

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
      enablePoints={true}
      pointSize={4}
      pointBorderWidth={1}
      pointBorderColor={{ from: "serieColor" }}
      pointColor="#1A1A1A"
      lineWidth={2}
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
