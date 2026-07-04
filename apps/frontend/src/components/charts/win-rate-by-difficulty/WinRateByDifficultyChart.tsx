import { ResponsiveLine } from "@nivo/line";
import { nivoTheme } from "@/theme/nivo-theme";
import { SERIES_GRADIENT } from "@/lib/colors";
import { getSeriesColor } from "@/lib/chart-colors";
import { difficultyAxisSubtitle } from "@/components/charts/common/BottomAxisSubtitle";
import { createDifficultyTickRenderer } from "@/components/charts/common/DifficultyTick";
import { createGradientLines } from "@/components/charts/common/GradientLines";
import { createLineTooltip } from "@/components/charts/common/LineTooltip";
import { useDifficultyCurveK } from "@/lib/difficulty-curve";
import type { WinRateByDifficultyResult } from "./use-win-rate-by-difficulty";

const tooltip = createLineTooltip({
  xLabel: "Difficulty",
  yLabel: "Win Rate",
  yFormat: (v) => `${v.toFixed(1)}%`,
});

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

export interface WinRateByDifficultyChartProps {
  data: WinRateByDifficultyResult;
}

export function WinRateByDifficultyChart({ data }: WinRateByDifficultyChartProps) {
  const { series, xMin, xMax } = data;
  const k = useDifficultyCurveK();
  if (series.length === 0) return null;

  return (
    <div data-qa="chart-win-rate-by-difficulty" style={{ width: "100%", height: "100%" }}>
      <ResponsiveLine
        data={series}
        theme={nivoTheme}
        colors={(series) => getSeriesColor(String(series.id))}
        margin={{ top: 20, right: 20, bottom: 88, left: 60 }}
        xScale={{ type: "linear", min: xMin, max: xMax, reverse: true }}
        yScale={{ type: "linear", min: 0, max: 100, stacked: false }}
        curve="monotoneX"
        enableArea={true}
        areaOpacity={0.08}
        enablePoints={true}
        pointSize={4}
        pointBorderWidth={1}
        pointBorderColor={{ from: "serieColor" }}
        pointColor="#1A1A1A"
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
          difficultyAxisSubtitle,
        ]}
        axisBottom={{
          legend: "Difficulty",
          legendOffset: 64,
          legendPosition: "middle",
          tickValues: 5,
          tickRotation: -30, // angled two-line ticks: "0.746" over "(-14540)"
          renderTick: createDifficultyTickRenderer(k),
        }}
        axisLeft={{
          legend: "Win Rate (%)",
          legendOffset: -50,
          legendPosition: "middle",
        }}
        tooltip={tooltip}
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
