import { ResponsivePie } from "@nivo/pie";
import { nivoTheme } from "../../theme/nivo-theme";
import { SERIES_COLORS, SERIES_GRADIENT } from "../../lib/colors";
import { createPieGradientProps } from "../GradientPie";
import { formatSeconds } from "../../lib/format";
import type { ComputeUsedEntry } from "../../hooks/use-compute-used";
import type { MinerCategory } from "../../types/telemetry";

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
    <div data-qa="chart-compute-used" style={{ width: "100%", height: "100%" }}>
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
      defs={pieGradient.defs}
      fill={pieGradient.fill}
    />
    </div>
  );
}
