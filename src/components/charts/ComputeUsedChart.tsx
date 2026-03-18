import { ResponsiveBar } from "@nivo/bar";
import { nivoTheme } from "../../theme/nivo-theme";
import { SERIES_COLORS } from "../../lib/colors";
import { formatSeconds } from "../../lib/format";
import type { ComputeUsedEntry } from "../../hooks/use-compute-used";
import type { MinerCategory } from "../../types/telemetry";

export interface ComputeUsedChartProps {
  data: ComputeUsedEntry[];
}

export function ComputeUsedChart({ data }: ComputeUsedChartProps) {
  if (data.length === 0) return null;

  return (
    <ResponsiveBar
      data={data}
      keys={["compute"]}
      indexBy="minerType"
      theme={nivoTheme}
      colors={(bar) => SERIES_COLORS[bar.data.minerType as MinerCategory] ?? "#999"}
      margin={{ top: 20, right: 20, bottom: 50, left: 80 }}
      padding={0.4}
      borderRadius={4}
      axisBottom={{
        legend: "Miner Type",
        legendOffset: 40,
        legendPosition: "middle",
      }}
      axisLeft={{
        legend: "Total Compute (seconds)",
        legendOffset: -70,
        legendPosition: "middle",
        format: (v) => formatSeconds(Number(v)),
      }}
      labelSkipWidth={40}
      label={(d) => formatSeconds(Number(d.value))}
      labelTextColor="#1A1A1A"
      enableGridY={true}
    />
  );
}
