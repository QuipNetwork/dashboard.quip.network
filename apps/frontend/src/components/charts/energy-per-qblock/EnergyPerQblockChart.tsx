// SPDX-License-Identifier: AGPL-3.0-or-later

import { ResponsiveLine } from "@nivo/line";

import { createLineTooltip } from "@/components/charts/common/LineTooltip";
import { labelForCategoryWith, useQpuDisplayLabel } from "@/components/charts/common/qpu-label";
import { getSeriesColor } from "@/lib/chart-colors";
import { formatJoules } from "@/lib/format";
import { nivoTheme } from "@/theme/nivo-theme";

import type { EnergySeries } from "./use-energy-per-qblock";

export interface EnergyPerQblockChartProps {
  data: EnergySeries[];
}

export function EnergyPerQblockChart({ data }: EnergyPerQblockChartProps) {
  const qpuLabel = useQpuDisplayLabel();
  if (data.length === 0) return null;

  const labelFor = labelForCategoryWith(qpuLabel);
  // Stacked areas: nivo keeps each point's own y for the tooltip and stacks
  // only the rendered geometry, so the hover value is the type's own joules.
  const tooltip = createLineTooltip({
    xLabel: "QBlock",
    yLabel: "Energy",
    xFormat: (v) => String(Math.round(v)),
    yFormat: formatJoules,
    seriesLabel: labelFor,
  });

  return (
    <div data-qa="chart-energy-per-qblock" style={{ width: "100%", height: "100%" }}>
      <ResponsiveLine
        data={data}
        theme={nivoTheme}
        colors={(s) => getSeriesColor(String(s.id))}
        margin={{ top: 20, right: 20, bottom: 48, left: 72 }}
        xScale={{ type: "linear", min: "auto", max: "auto" }}
        yScale={{ type: "linear", min: 0, max: "auto", stacked: true }}
        curve="monotoneX"
        enableArea={true}
        areaOpacity={0.35}
        enablePoints={false}
        lineWidth={1}
        axisBottom={{
          legend: "QBlock",
          legendOffset: 40,
          legendPosition: "middle",
          tickValues: 6,
          format: (v) => String(Math.round(Number(v))),
        }}
        axisLeft={{
          legend: "Estimated energy",
          legendOffset: -64,
          legendPosition: "middle",
          tickValues: 5,
          format: (v) => formatJoules(Number(v)),
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
            data: data.map((s) => ({
              id: s.id,
              label: labelFor(s.id),
              color: getSeriesColor(s.id),
            })),
          },
        ]}
      />
    </div>
  );
}
