// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { ResponsiveLine } from "@nivo/line";
import { nivoTheme } from "@/theme/nivo-theme";
import { difficultyAxisSubtitle } from "@/components/charts/common/BottomAxisSubtitle";
import { createDifficultyTickRenderer } from "@/components/charts/common/DifficultyTick";
import { createLineTooltip } from "@/components/charts/common/LineTooltip";
import {
  colorForNormalizedSeries as colorFor,
  normalizedSeriesGradientLines as gradientLines,
} from "@/components/charts/common/normalized-series-colors";
import {
  NODE_SCOPE_OPTIONS,
  SegToggle,
  type SegOption,
} from "@/components/charts/common/SegToggle";
import { labelForCategoryWith, useQpuDisplayLabel } from "@/components/charts/common/qpu-label";
import { useDifficultyCurveK } from "@/lib/difficulty-curve";
import { useWinRateByDifficulty, type WinRateMode } from "./use-win-rate-by-difficulty";

// This chart's own mode list: the shared All|Best scopes plus Normalized
// (NODE_SCOPE_OPTIONS itself stays two-valued for its other consumers).
const MODE_OPTIONS: ReadonlyArray<SegOption<WinRateMode>> = [
  ...NODE_SCOPE_OPTIONS,
  { value: "normalized", label: "Normalized" },
];

export function WinRateByDifficultyChart() {
  const [mode, setMode] = useState<WinRateMode>("all");
  const { series, xMin, xMax } = useWinRateByDifficulty({ mode });
  const k = useDifficultyCurveK();
  const qpuLabel = useQpuDisplayLabel();

  // Normalized series carry display labels ("QPU100" -> "QPU100%"); nivo's
  // legend and tooltip show the id, so render under the label. Raw all/best
  // series have no label — labelFor covers the plain "QPU" case (-> live
  // "QPU<N>m", which colorForNormalizedSeries already resolves a color for).
  const labelFor = labelForCategoryWith(qpuLabel);
  const chartSeries = series.map((s) => ({
    id: s.label ?? labelFor(s.id),
    data: s.data,
  }));
  const yLabel = mode === "normalized" ? "Win Share" : "Win Rate";
  const tooltip = useMemo(
    () =>
      createLineTooltip({
        xLabel: "Difficulty",
        yLabel,
        yFormat: (v) => `${v.toFixed(1)}%`,
        colorFor,
      }),
    [yLabel],
  );

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
