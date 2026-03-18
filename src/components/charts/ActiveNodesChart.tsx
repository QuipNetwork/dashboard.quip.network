import { ResponsiveBar } from "@nivo/bar";
import { nivoTheme } from "../../theme/nivo-theme";
import { SERIES_COLORS } from "../../lib/colors";
import type { ActiveNodesEntry } from "../../hooks/use-active-nodes";
import type { MinerCategory } from "../../types/telemetry";

export interface ActiveNodesChartProps {
  data: ActiveNodesEntry[];
}

export function ActiveNodesChart({ data }: ActiveNodesChartProps) {
  if (data.length === 0) return null;

  return (
    <ResponsiveBar
      data={data}
      keys={["count"]}
      indexBy="minerType"
      theme={nivoTheme}
      colors={(bar) => SERIES_COLORS[bar.data.minerType as MinerCategory] ?? "#999"}
      margin={{ top: 20, right: 20, bottom: 50, left: 50 }}
      padding={0.4}
      borderRadius={4}
      axisBottom={{
        legend: "Miner Type",
        legendOffset: 40,
        legendPosition: "middle",
      }}
      axisLeft={{
        legend: "Node Count",
        legendOffset: -40,
        legendPosition: "middle",
      }}
      labelTextColor="#1A1A1A"
      enableGridY={true}
    />
  );
}
