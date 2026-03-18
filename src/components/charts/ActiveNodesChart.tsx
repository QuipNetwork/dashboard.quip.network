import { ResponsivePie } from "@nivo/pie";
import { nivoTheme } from "../../theme/nivo-theme";
import { SERIES_COLORS } from "../../lib/colors";
import type { ActiveNodesEntry } from "../../hooks/use-active-nodes";
import type { MinerCategory } from "../../types/telemetry";

export interface ActiveNodesChartProps {
  data: ActiveNodesEntry[];
}

export function ActiveNodesChart({ data }: ActiveNodesChartProps) {
  if (data.length === 0) return null;

  const pieData = data.map((d) => ({
    id: d.minerType,
    label: d.minerType,
    value: d.count,
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
      activeOuterRadiusOffset={8}
    />
  );
}
