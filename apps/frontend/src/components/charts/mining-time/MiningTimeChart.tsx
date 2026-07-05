import { ResponsiveLine } from "@nivo/line";
import { nivoTheme } from "@/theme/nivo-theme";
import { createLineTooltip } from "@/components/charts/common/LineTooltip";
import {
  colorForNormalizedSeries as colorFor,
  normalizedSeriesGradientLines as gradientLines,
} from "@/components/charts/common/normalized-series-colors";
import { displayLabelForCategory } from "@/components/charts/common/qpu-label";
import { formatJoules } from "@/lib/format";
import type { MiningMetric, MiningTimeSeries } from "./use-mining-time";

export interface MiningTimeChartProps {
  data: MiningTimeSeries[];
  // Which winner metric the series carry — drives axis/tooltip formatting.
  metric?: MiningMetric;
  // Normalized-composition shares (0–100%) rather than raw metric values.
  normalized?: boolean;
}

export function MiningTimeChart({
  data,
  metric = "time",
  normalized = false,
}: MiningTimeChartProps) {
  if (data.length === 0) return null;

  // Normalized series carry display labels ("QPU100" -> "QPU100%"); nivo's
  // legend and tooltip show the id, so render under the label. Raw byType/all
  // series have no label — displayLabelForCategory covers the plain "QPU"
  // case (-> "QPU20m", which colorForNormalizedSeries already resolves a
  // color for).
  const chartSeries = data.map((s) => ({
    id: s.label ?? displayLabelForCategory(s.id),
    data: s.data,
  }));

  const yLabel = normalized ? "Share" : metric === "energy" ? "Energy" : "Device Time";
  const yFormat = normalized
    ? (v: number) => `${v.toFixed(1)}%`
    : metric === "energy"
      ? formatJoules
      : (v: number) => `${v.toFixed(1)}s`;
  const axisLegend = normalized
    ? metric === "energy"
      ? "Share of Energy (%)"
      : "Share of Device Time (%)"
    : metric === "energy"
      ? "Energy per QBlock"
      : "Device Time (seconds)";
  const tooltip = createLineTooltip({
    xLabel: "QBlock",
    yLabel,
    xFormat: (v) => String(Math.round(v)),
    yFormat,
    colorFor,
  });

  return (
    <div data-qa="chart-mining-time" style={{ width: "100%", height: "100%" }}>
      <ResponsiveLine
        data={chartSeries}
        theme={nivoTheme}
        colors={(series) => colorFor(String(series.id))}
        margin={{ top: 20, right: 20, bottom: 50, left: 60 }}
        // min "auto" hugs the windowed data — nivo's default of 0 would
        // stretch the axis back to qblock #0 on every range.
        xScale={{ type: "linear", min: "auto", max: "auto" }}
        yScale={
          normalized
            ? { type: "linear", min: 0, max: 100, stacked: false }
            : { type: "linear", min: 0, stacked: false }
        }
        curve="monotoneX"
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
          "crosshair",
          gradientLines,
          "slices",
          "points",
          "mesh",
          "legends",
        ]}
        axisBottom={{
          // Large ids on a zoomed linear scale render fractional /
          // scientific ticks by default — coerce to plain integers.
          format: (v) => String(Math.round(Number(v))),
          tickValues: 6,
          legend: "QBlock #",
          legendOffset: 40,
          legendPosition: "middle",
        }}
        axisLeft={{
          // Joule ticks carry their own unit ladder (J/kJ/MJ).
          format: !normalized && metric === "energy" ? (v) => formatJoules(Number(v)) : undefined,
          legend: axisLegend,
          legendOffset: -50,
          legendPosition: "middle",
        }}
        tooltip={tooltip}
        useMesh={true}
        enableCrosshair={true}
        legends={
          chartSeries.length <= 5
            ? [
                {
                  anchor: "top-left",
                  direction: "row",
                  // Four items in normalized mode, incl. "QPU100%".
                  itemWidth: normalized ? 78 : 70,
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
