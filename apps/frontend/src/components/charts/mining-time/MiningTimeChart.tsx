import type { PointTooltipProps } from "@nivo/line";
import { ResponsiveLine } from "@nivo/line";
import { nivoTheme } from "@/theme/nivo-theme";
import { SERIES_COLORS, SERIES_GRADIENT } from "@/lib/colors";
import { getSeriesColor } from "@/lib/chart-colors";
import { createGradientLines } from "@/components/charts/common/GradientLines";
import { NORMALIZED_SERIES_LABELS } from "@/components/charts/common/normalized-composition";
import { formatJoules, type MiningMetric, type MiningTimeSeries } from "./use-mining-time";

// QPU100% needs a colour distinguishable from the QPU emerald while still
// reading as "quantum" — same lime treatment as WinRateByDifficultyChart
// (lib/colors stays type-keyed).
const QPU100_COLOR = "#84CC16";
const QPU100_GRADIENT: [string, string] = ["#84CC16", "#BEF264"];

// Normalized-mode series render under their display labels; the two QPU
// regimes aren't type keys, so resolve their colours locally.
const EXTRA_SERIES_COLORS: Record<string, string> = {
  [NORMALIZED_SERIES_LABELS.QPU20m]: SERIES_COLORS.QPU,
  [NORMALIZED_SERIES_LABELS.QPU100]: QPU100_COLOR,
};

function colorFor(id: string): string {
  return EXTRA_SERIES_COLORS[id] ?? getSeriesColor(id);
}

const gradientLines = createGradientLines(
  Object.fromEntries(
    Object.entries({
      ...SERIES_GRADIENT,
      [NORMALIZED_SERIES_LABELS.QPU20m]: SERIES_GRADIENT.QPU,
      [NORMALIZED_SERIES_LABELS.QPU100]: QPU100_GRADIENT,
    }).map(([id, [from, to]]) => [
      id,
      [
        { offset: "0%", color: from },
        { offset: "100%", color: to },
      ],
    ]),
  ),
);

// Local tooltip (mirrors common/LineTooltip): the shared one resolves swatch
// colours through getSeriesColor only, which can't know the QPU20m/QPU100%
// series — this one goes through colorFor.
function createTooltip(yLabel: string, yFormat: (v: number) => string) {
  return function MiningTimeTooltip({ point }: PointTooltipProps) {
    return (
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #d4d4d8",
          borderRadius: 6,
          padding: "8px 12px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          fontFamily: "'ABC Favotit Mono', monospace",
          fontSize: 12,
          color: "#27272a",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              backgroundColor: colorFor(String(point.serieId)),
              flexShrink: 0,
            }}
          />
          <span style={{ fontWeight: 600 }}>{String(point.serieId)}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span>
            <span style={{ color: "#52525c" }}>QBlock: </span>
            {String(Math.round(Number(point.data.x)))}
          </span>
          <span>
            <span style={{ color: "#52525c" }}>{yLabel}: </span>
            {yFormat(Number(point.data.y))}
          </span>
        </div>
      </div>
    );
  };
}

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
  // legend and tooltip show the id, so render under the label.
  const chartSeries = data.map((s) => ({ id: s.label ?? s.id, data: s.data }));

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
  const tooltip = createTooltip(yLabel, yFormat);

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
