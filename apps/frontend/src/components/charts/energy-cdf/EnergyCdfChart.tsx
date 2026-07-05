import { useMemo, useState } from "react";
import { ResponsiveLine } from "@nivo/line";
import { nivoTheme } from "@/theme/nivo-theme";
import { SERIES_GRADIENT } from "@/lib/colors";
import { getSeriesColor } from "@/lib/chart-colors";
import { difficultyAxisSubtitle } from "@/components/charts/common/BottomAxisSubtitle";
import { createDifficultyTickRenderer } from "@/components/charts/common/DifficultyTick";
import { createGradientLines } from "@/components/charts/common/GradientLines";
import { createLineTooltip } from "@/components/charts/common/LineTooltip";
import { labelForCategoryWith, useQpuDisplayLabel } from "@/components/charts/common/qpu-label";
import {
  NODE_SCOPE_OPTIONS,
  SegToggle,
  type NodeScope,
} from "@/components/charts/common/SegToggle";
import { useDifficultyCurveK } from "@/lib/difficulty-curve";
import { useEnergyCdf } from "./use-energy-cdf";

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

export function EnergyCdfChart() {
  const [scope, setScope] = useState<NodeScope>("all");
  const { series, xMin, xMax } = useEnergyCdf({ scope });
  const k = useDifficultyCurveK();
  const qpuLabel = useQpuDisplayLabel();
  const labelFor = labelForCategoryWith(qpuLabel);
  const tooltip = useMemo(
    () =>
      createLineTooltip({
        xLabel: "Difficulty",
        yLabel: "Probability",
        yFormat: (v) => `${v.toFixed(1)}%`,
        seriesLabel: labelForCategoryWith(qpuLabel),
      }),
    [qpuLabel],
  );

  return (
    <div data-qa="chart-energy-cdf" className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <SegToggle
          value={scope}
          onChange={setScope}
          options={NODE_SCOPE_OPTIONS}
          ariaLabel="Node scope"
        />
      </div>
      <div className="min-h-0 flex-1">
        {series.length === 0 ? (
          <p className="flex h-full items-center justify-center font-accent text-sm text-ink-subtle">
            No data
          </p>
        ) : (
          <ResponsiveLine
            data={series}
            theme={nivoTheme}
            colors={(s) => getSeriesColor(String(s.id))}
            margin={{ top: 20, right: 20, bottom: 88, left: 60 }}
            xScale={{ type: "linear", min: xMin, max: xMax, reverse: true }}
            yScale={{ type: "linear", min: 0, max: 100, stacked: false }}
            curve="monotoneX"
            enableArea={true}
            areaOpacity={0.08}
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
              tickRotation: -30, // angled two-line ticks: "0.746" over "(-14540)"
              renderTick: createDifficultyTickRenderer(k),
            }}
            axisLeft={{
              legend: "Probability (%)",
              legendOffset: -50,
              legendPosition: "middle",
            }}
            tooltip={tooltip}
            useMesh={true}
            enableCrosshair={true}
            legends={
              series.length <= 5
                ? [
                    {
                      anchor: "top-left",
                      direction: "row",
                      itemWidth: 70,
                      itemHeight: 20,
                      symbolSize: 10,
                      symbolShape: "circle",
                      translateY: -15,
                      // Override the id-derived default so "QPU" renders under
                      // the live budget label without touching the series id nivo colors by.
                      data: series.map((s) => ({
                        id: s.id,
                        label: labelFor(s.id),
                        color: getSeriesColor(s.id),
                      })),
                    },
                  ]
                : []
            }
          />
        )}
      </div>
    </div>
  );
}
