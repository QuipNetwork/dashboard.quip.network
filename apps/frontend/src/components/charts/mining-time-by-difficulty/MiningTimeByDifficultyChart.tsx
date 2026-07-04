// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { ResponsiveLine } from "@nivo/line";

import { nivoTheme } from "@/theme/nivo-theme";
import { SERIES_GRADIENT } from "@/lib/colors";
import { getSeriesColor } from "@/lib/chart-colors";
import { difficultyAxisSubtitle } from "@/components/charts/common/BottomAxisSubtitle";
import { createDifficultyTickRenderer } from "@/components/charts/common/DifficultyTick";
import { createGradientLines } from "@/components/charts/common/GradientLines";
import { createLineTooltip } from "@/components/charts/common/LineTooltip";
import {
  NODE_SCOPE_OPTIONS,
  SegToggle,
  type NodeScope,
  type SegOption,
} from "@/components/charts/common/SegToggle";
import { formatDifficultyTick, useDifficultyCurveK } from "@/lib/difficulty-curve";
import { formatDuration } from "@/lib/format";
import { useMiningTimeByDifficulty, type CostUnits } from "./use-mining-time-by-difficulty";

// QPUWC is the time-mode label for the QPU wall-clock line — same palette.
const gradientLines = createGradientLines(
  Object.fromEntries(
    Object.entries({ ...SERIES_GRADIENT, QPUWC: SERIES_GRADIENT.QPU }).map(([id, [from, to]]) => [
      id,
      [
        { offset: "0%", color: from },
        { offset: "100%", color: to },
      ],
    ]),
  ),
);

const UNITS_OPTIONS: ReadonlyArray<SegOption<CostUnits>> = [
  { value: "time", label: "Time" },
  { value: "attempts", label: "Attempts" },
];

export function MiningTimeByDifficultyChart() {
  const [units, setUnits] = useState<CostUnits>("time");
  const [scope, setScope] = useState<NodeScope>("all");
  const { series, xMin, xMax, note } = useMiningTimeByDifficulty({ units, scope });
  const k = useDifficultyCurveK();

  const yLegend = units === "time" ? "Expected time to qblock" : "Expected qblocks to mine";
  const formatY = (v: number) => (units === "time" ? formatDuration(v * 1000) : `${v.toFixed(1)}×`);

  const tooltip = useMemo(
    () =>
      createLineTooltip({
        xLabel: "Difficulty",
        yLabel: units === "time" ? "Expected time" : "Expected qblocks",
        xFormat: (v) => formatDifficultyTick(Number(v), k),
        yFormat: formatY,
      }),
    // formatY is derived from units; k only affects the x tooltip label.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [units, k],
  );

  return (
    <div data-qa="chart-mining-time-by-difficulty" className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <SegToggle
          value={scope}
          onChange={setScope}
          options={NODE_SCOPE_OPTIONS}
          ariaLabel="Node scope"
        />
        <SegToggle
          value={units}
          onChange={setUnits}
          options={UNITS_OPTIONS}
          ariaLabel="Cost units"
        />
      </div>
      <div className="min-h-0 flex-1">
        {series.length === 0 ? (
          <p className="flex h-full items-center justify-center font-accent text-sm text-ink-subtle">
            {note ?? "No data"}
          </p>
        ) : (
          <ResponsiveLine
            data={series}
            theme={nivoTheme}
            colors={(s) => getSeriesColor(s.id === "QPUWC" ? "QPU" : String(s.id))}
            // Left margin fits time-mode tick labels ("22h 13m", "1d 20h")
            // with the axis legend clear of them.
            margin={{ top: 20, right: 20, bottom: 88, left: 92 }}
            xScale={{ type: "linear", min: xMin, max: xMax, reverse: true }}
            yScale={{ type: "linear", min: 0, stacked: false }}
            curve="monotoneX"
            // Three curves share the plot: no per-sample dots (50 per curve)
            // and no area washes, or they smear into each other.
            enableArea={false}
            enablePoints={false}
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
              // Angled two-line ticks ("0.746" over "(-14540)") — one flat
              // line collides with its neighbours.
              tickRotation: -30,
              renderTick: createDifficultyTickRenderer(k),
            }}
            axisLeft={{
              legend: yLegend,
              legendOffset: -84,
              legendPosition: "middle",
              tickValues: 6, // duration labels crowd at nivo's default density
              format: formatY,
            }}
            tooltip={tooltip}
            useMesh={true}
            enableCrosshair={true}
            legends={[
              {
                anchor: "top-left",
                direction: "row",
                itemWidth: 90,
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
