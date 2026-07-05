import { ResponsivePie } from "@nivo/pie";
import { nivoTheme } from "@/theme/nivo-theme";
import { SERIES_GRADIENT } from "@/lib/colors";
import { getSeriesColor } from "@/lib/chart-colors";
import { createPieGradientProps } from "@/components/charts/common/GradientPie";
import { displayLabelForCategory } from "@/components/charts/common/qpu-label";
import type { ActiveNodesEntry } from "./use-active-nodes";

const pieGradient = createPieGradientProps(
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

export interface ActiveNodesChartProps {
  data: ActiveNodesEntry[];
}

export function ActiveNodesChart({ data }: ActiveNodesChartProps) {
  if (data.length === 0) return null;

  const pieData = data.map((d) => ({
    id: d.minerType,
    label: displayLabelForCategory(d.minerType),
    value: d.count,
  }));

  return (
    <div data-qa="chart-active-nodes" style={{ width: "100%", height: "100%" }}>
      <ResponsivePie
        data={pieData}
        theme={nivoTheme}
        colors={(d) => getSeriesColor(String(d.id))}
        margin={{ top: 30, right: 80, bottom: 30, left: 80 }}
        innerRadius={0.5}
        padAngle={2}
        cornerRadius={4}
        borderWidth={1}
        borderColor={{ from: "color", modifiers: [["darker", 0.6]] }}
        arcLinkLabelsColor={{ from: "color" }}
        arcLinkLabelsTextColor="#27272a"
        arcLinkLabelsThickness={2}
        arcLabelsTextColor="#1A1A1A"
        activeOuterRadiusOffset={8}
        defs={pieGradient.defs}
        fill={pieGradient.fill}
      />
    </div>
  );
}
