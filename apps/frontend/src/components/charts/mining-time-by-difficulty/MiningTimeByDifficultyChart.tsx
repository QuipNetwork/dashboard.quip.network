// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { ResponsiveLine } from "@nivo/line";
import clsx from "clsx";

import { nivoTheme } from "@/theme/nivo-theme";
import { SERIES_GRADIENT } from "@/lib/colors";
import { getSeriesColor } from "@/lib/chart-colors";
import { createGradientLines } from "@/components/charts/common/GradientLines";
import { createLineTooltip } from "@/components/charts/common/LineTooltip";
import { formatDifficultyTick, useDifficultyCurveK } from "@/lib/difficulty-curve";
import { formatDuration } from "@/lib/format";
import {
  useMiningTimeByDifficulty,
  type CostScope,
  type CostUnits,
} from "./use-mining-time-by-difficulty";

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

interface SegOption<T extends string> {
  value: T;
  label: string;
}

// Compact two-state segmented control, styled to match the header's
// aggregation toggle.
function SegToggle<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<SegOption<T>>;
  ariaLabel: string;
}) {
  return (
    <div className="flex overflow-hidden border border-border" role="group" aria-label={ariaLabel}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={clsx(
              "cursor-pointer px-2.5 py-1 font-accent text-xs transition-colors",
              active
                ? "bg-surface-dark text-ink-on-dark"
                : "text-ink-subtle hover:bg-surface-1 hover:text-ink-strong",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

const SCOPE_OPTIONS: ReadonlyArray<SegOption<CostScope>> = [
  { value: "all", label: "All Nodes" },
  { value: "best", label: "Best Node" },
];
const UNITS_OPTIONS: ReadonlyArray<SegOption<CostUnits>> = [
  { value: "time", label: "Time" },
  { value: "attempts", label: "Attempts" },
];

export function MiningTimeByDifficultyChart() {
  const [units, setUnits] = useState<CostUnits>("time");
  const [scope, setScope] = useState<CostScope>("all");
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
          options={SCOPE_OPTIONS}
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
            colors={(s) => getSeriesColor(String(s.id))}
            margin={{ top: 20, right: 20, bottom: 50, left: 64 }}
            xScale={{ type: "linear", min: xMin, max: xMax, reverse: true }}
            yScale={{ type: "linear", min: 0, stacked: false }}
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
            ]}
            axisBottom={{
              legend: "(lower energy == more difficult)",
              legendOffset: 40,
              legendPosition: "middle",
              tickValues: 5,
              format: (v) => formatDifficultyTick(Number(v), k),
            }}
            axisLeft={{
              legend: yLegend,
              legendOffset: -56,
              legendPosition: "middle",
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
