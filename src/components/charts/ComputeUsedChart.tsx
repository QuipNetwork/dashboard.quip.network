import { ResponsivePie } from "@nivo/pie";
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

  const pieData = data.map((d) => ({
    id: d.minerType,
    label: d.minerType,
    value: d.compute,
  }));

  return (
    <ResponsivePie
      data={pieData}
      theme={nivoTheme}
      colors={(d) => SERIES_COLORS[d.id as MinerCategory] ?? "#999"}
      margin={{ top: 30, right: 80, bottom: 30, left: 80 }}
      innerRadius={0.5}
      padAngle={2}
      cornerRadius={4}
      borderWidth={1}
      borderColor={{ from: "color", modifiers: [["darker", 0.6]] }}
      arcLinkLabelsColor={{ from: "color" }}
      arcLinkLabelsTextColor="#DCDCDC"
      arcLinkLabelsThickness={2}
      arcLabelsTextColor="#1A1A1A"
      valueFormat={(v) => formatSeconds(v)}
      activeOuterRadiusOffset={8}
    />
  );
}
