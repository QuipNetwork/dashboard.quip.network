// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { ResponsiveLine, type PointTooltipProps } from "@nivo/line";
import { nivoTheme } from "@/theme/nivo-theme";
import { SERIES_COLORS, SERIES_GRADIENT } from "@/lib/colors";
import { getSeriesColor } from "@/lib/chart-colors";
import { difficultyAxisSubtitle } from "@/components/charts/common/BottomAxisSubtitle";
import { createDifficultyTickRenderer } from "@/components/charts/common/DifficultyTick";
import { createGradientLines } from "@/components/charts/common/GradientLines";
import {
  NODE_SCOPE_OPTIONS,
  SegToggle,
  type SegOption,
} from "@/components/charts/common/SegToggle";
import { NORMALIZED_SERIES_LABELS } from "@/components/charts/common/normalized-composition";
import { useDifficultyCurveK } from "@/lib/difficulty-curve";
import {
  useWinRateByDifficulty,
  type WinRateByDifficultyResult,
  type WinRateMode,
} from "./use-win-rate-by-difficulty";

// This chart's own mode list: the shared All|Best scopes plus Normalized
// (NODE_SCOPE_OPTIONS itself stays two-valued for its other consumers).
const MODE_OPTIONS: ReadonlyArray<SegOption<WinRateMode>> = [
  ...NODE_SCOPE_OPTIONS,
  { value: "normalized", label: "Normalized" },
];

// QPU100% needs a colour distinguishable from the QPU emerald while still
// reading as "quantum" — lime, derived locally (lib/colors stays type-keyed).
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
function createTooltip(yLabel: string) {
  return function WinRateTooltip({ point }: PointTooltipProps) {
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
            <span style={{ color: "#52525c" }}>Difficulty: </span>
            {Number(point.data.x).toLocaleString("en-US", { maximumFractionDigits: 1 })}
          </span>
          <span>
            <span style={{ color: "#52525c" }}>{yLabel}: </span>
            {`${Number(point.data.y).toFixed(1)}%`}
          </span>
        </div>
      </div>
    );
  };
}

export interface WinRateByDifficultyChartProps {
  // Legacy wiring: ComputeAvailableView still computes and passes the default
  // (All Nodes) result, but the chart owns its data now — the in-chart mode
  // toggle re-queries the hook per mode, so this prop is ignored. Drop it
  // together with the view's useWinRateByDifficulty() call.
  data?: WinRateByDifficultyResult;
}

export function WinRateByDifficultyChart(_props: WinRateByDifficultyChartProps) {
  const [mode, setMode] = useState<WinRateMode>("all");
  const { series, xMin, xMax } = useWinRateByDifficulty({ mode });
  const k = useDifficultyCurveK();

  // Normalized series carry display labels ("QPU100" -> "QPU100%"); nivo's
  // legend and tooltip show the id, so render under the label.
  const chartSeries = series.map((s) => ({ id: s.label ?? s.id, data: s.data }));
  const yLabel = mode === "normalized" ? "Win Share" : "Win Rate";
  const tooltip = useMemo(() => createTooltip(yLabel), [yLabel]);

  return (
    <div data-qa="chart-win-rate-by-difficulty" className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-end">
        <SegToggle value={mode} onChange={setMode} options={MODE_OPTIONS} ariaLabel="Node scope" />
      </div>
      <div className="min-h-0 flex-1">
        {chartSeries.length === 0 ? (
          <p className="flex h-full items-center justify-center font-accent text-sm text-ink-subtle">
            No data
          </p>
        ) : (
          <ResponsiveLine
            data={chartSeries}
            theme={nivoTheme}
            colors={(s) => colorFor(String(s.id))}
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
              legend: `${yLabel} (%)`,
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
                itemWidth: 78, // four items in normalized mode, incl. "QPU100%"
                itemHeight: 20,
                symbolSize: 10,
                symbolShape: "circle",
                translateY: -15,
              },
            ]}
          />
        )}
      </div>
    </div>
  );
}
